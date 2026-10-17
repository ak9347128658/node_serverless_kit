import { describe, expect, it } from "vitest";
import { AwsProvider } from "../../src/providers/aws.js";
import { getProvider } from "../../src/providers/registry.js";
import { fullConfig, makeProject, render } from "../helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tf = Record<string, any>;

const project = (yaml: string) => makeProject(yaml).load();
const tf = (yaml: string): Tf => render(project(yaml));
const values = (bucket: Record<string, any> | undefined) => Object.values(bucket ?? {}) as any[];

describe("full render", () => {
  const out = tf(fullConfig("aws", "eu-west-1"));
  const res = out.resource;

  it("declares the provider", () => {
    expect(out.terraform.required_providers.aws).toEqual({ source: "hashicorp/aws", version: ">= 5.40" });
    expect(out.terraform.required_version).toBe(">= 1.5.0");
    expect(out.provider.aws).toEqual([
      { region: "eu-west-1", default_tags: { tags: { "nskit-service": "demo", "nskit-stage": "dev", "managed-by": "node_serverless_kit" } } },
    ]);
  });

  it("creates every resource type", () => {
    for (const type of [
      "aws_lambda_function",
      "aws_iam_role",
      "aws_iam_role_policy_attachment",
      "aws_cloudwatch_log_group",
      "aws_apigatewayv2_api",
      "aws_apigatewayv2_stage",
      "aws_apigatewayv2_integration",
      "aws_apigatewayv2_route",
      "aws_lambda_permission",
      "aws_scheduler_schedule",
      "aws_sqs_queue",
      "aws_lambda_event_source_mapping",
      "aws_s3_bucket",
      "aws_s3_bucket_notification",
      "aws_s3_object",
      "aws_sns_topic",
      "aws_sns_topic_subscription",
      "aws_sfn_state_machine",
    ]) {
      expect(res, type).toHaveProperty(type);
    }
    expect(Object.keys(res.aws_lambda_function).sort()).toEqual(["hello", "step", "tick", "worker"]);
  });

  it("configures lambdas", () => {
    const hello = res.aws_lambda_function.hello;
    expect(hello).toMatchObject({
      function_name: "demo-dev-hello",
      description: "",
      role: "${aws_iam_role.lambda.arn}",
      handler: "index.handler",
      runtime: "nodejs22.x",
      memory_size: 256,
      timeout: 30,
      architectures: ["x86_64"],
      source_code_hash: expect.any(String),
      s3_bucket: "${aws_s3_object.artifact.bucket}",
      s3_key: "${aws_s3_object.artifact.key}",
      depends_on: ["aws_cloudwatch_log_group.logs-hello".replace("logs-hello", "logs_hello")],
      tags: { "nskit-service": "demo", "nskit-stage": "dev", "managed-by": "node_serverless_kit" },
    });
    expect(hello).not.toHaveProperty("filename");
    expect(hello).not.toHaveProperty("reserved_concurrent_executions");
    const env = hello.environment.variables;
    expect(env).toMatchObject({
      NSKIT_FUNCTION: "hello",
      NSKIT_PROVIDER: "aws",
      NSKIT_SERVICE: "demo",
      NSKIT_STAGE: "dev",
      NSKIT_REGION: "eu-west-1",
      NSKIT_HANDLER: "src/handlers.hello",
      NODE_OPTIONS: "--enable-source-maps",
    });
    expect(res.aws_cloudwatch_log_group.logs_hello).toEqual({ name: "/aws/lambda/demo-dev-hello", retention_in_days: 14 });
  });

  it("uses one shared role with basic + SQS execution", () => {
    expect(Object.keys(res.aws_iam_role).sort()).toEqual(["lambda", "scheduler", "states"]);
    expect(JSON.parse(res.aws_iam_role.lambda.assume_role_policy).Statement[0].Principal).toEqual({ Service: "lambda.amazonaws.com" });
    expect(res.aws_iam_role.lambda.name).toBe("demo-dev-lambda");
    const attachments = values(res.aws_iam_role_policy_attachment).map((a) => a.policy_arn);
    expect(attachments).toContain("arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole");
    expect(attachments).toContain("arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole");
    expect(res.aws_iam_role_policy).not.toHaveProperty("lambda-custom");
  });

  it("wires HTTP routes through one API", () => {
    const routes = values(res.aws_apigatewayv2_route);
    expect(routes.map((r) => r.route_key).sort()).toEqual(["GET /hello/{name}", "POST /hello"]);
    for (const r of routes) {
      expect(r.target).toBe("integrations/${aws_apigatewayv2_integration.hello.id}");
      expect(r).not.toHaveProperty("authorization_type");
    }
    expect(res.aws_apigatewayv2_integration.hello).toMatchObject({
      integration_type: "AWS_PROXY",
      integration_uri: "${aws_lambda_function.hello.invoke_arn}",
      payload_format_version: "2.0",
      timeout_milliseconds: 30000,
    });
    expect(res.aws_apigatewayv2_api.http).toMatchObject({ name: "demo-dev", protocol_type: "HTTP" });
    expect(res.aws_apigatewayv2_api.http.cors_configuration).toEqual({
      allow_origins: ["*"],
      allow_methods: ["*"],
      allow_headers: ["*"],
      expose_headers: [],
      allow_credentials: false,
      max_age: 600,
    });
    expect(res.aws_apigatewayv2_stage.default).toMatchObject({ name: "$default", auto_deploy: true });
    expect(res.aws_lambda_permission["hello-apigw".replace("-", "_")]).toMatchObject({
      principal: "apigateway.amazonaws.com",
      source_arn: "${aws_apigatewayv2_api.http.execution_arn}/*/*",
      function_name: "${aws_lambda_function.hello.function_name}",
    });
  });

  it("creates schedules with envelope inputs", () => {
    const schedules = values(res.aws_scheduler_schedule);
    expect(schedules.map((s) => s.schedule_expression).sort()).toEqual(["cron(0 12 ? * 2 *)", "rate(5 minutes)"]);
    const inputs = schedules.map((s) => JSON.parse(s.target.input));
    expect(inputs).toContainEqual({ __nskit: "schedule", data: { report: "weekly" }, source: "aws.scheduler" });
    expect(inputs).toContainEqual({ __nskit: "schedule", data: null, source: "aws.scheduler" });
    expect(schedules[0]).toMatchObject({
      name: "demo-dev-tick-0",
      group_name: "default",
      state: "ENABLED",
      schedule_expression_timezone: "UTC",
      flexible_time_window: { mode: "OFF" },
      target: { arn: "${aws_lambda_function.tick.arn}", role_arn: "${aws_iam_role.scheduler.arn}", retry_policy: { maximum_retry_attempts: 2 } },
    });
    expect(JSON.parse(res.aws_iam_role.scheduler.assume_role_policy).Statement[0].Principal.Service).toBe("scheduler.amazonaws.com");
    expect(Object.keys(res.aws_iam_role_policy)).toContain("scheduler-invoke".replace("-", "_"));
  });

  it("creates queues, buckets and topics", () => {
    expect(res.aws_sqs_queue.q_jobs).toMatchObject({ name: "jobs", visibility_timeout_seconds: 180, message_retention_seconds: 1209600 });
    expect(res.aws_lambda_event_source_mapping.worker_jobs).toEqual({
      event_source_arn: "${aws_sqs_queue.q_jobs.arn}",
      function_name: "${aws_lambda_function.worker.arn}",
      batch_size: 10,
      function_response_types: ["ReportBatchItemFailures"],
    });
    const bucketLabel = "b_demo_uploads_1234";
    expect(res.aws_s3_bucket[bucketLabel]).toMatchObject({ bucket: "demo-uploads-1234" });
    expect(res.aws_s3_bucket_public_access_block[bucketLabel]).toMatchObject({ block_public_acls: true, restrict_public_buckets: true });
    expect(res.aws_s3_bucket_notification[bucketLabel]).toEqual({
      bucket: `\${aws_s3_bucket.${bucketLabel}.id}`,
      lambda_function: [{ lambda_function_arn: "${aws_lambda_function.worker.arn}", events: ["s3:ObjectCreated:*"], filter_suffix: ".csv" }],
      depends_on: ["aws_lambda_permission.worker_s3_demo_uploads_1234"],
    });
    expect(res.aws_lambda_permission.worker_s3_demo_uploads_1234).toMatchObject({
      principal: "s3.amazonaws.com",
      statement_id: "AllowS3-demo_uploads_1234",
      source_arn: `\${aws_s3_bucket.${bucketLabel}.arn}`,
    });
    expect(res.aws_sns_topic.t_events).toMatchObject({ name: "events" });
    expect(res.aws_sns_topic_subscription.worker_events).toEqual({
      topic_arn: "${aws_sns_topic.t_events.arn}",
      protocol: "lambda",
      endpoint: "${aws_lambda_function.worker.arn}",
    });
    expect(res.aws_lambda_permission.worker_sns_events).toMatchObject({ principal: "sns.amazonaws.com", source_arn: "${aws_sns_topic.t_events.arn}" });
  });

  it("compiles workflows to Step Functions with real ARNs", () => {
    const sm = res.aws_sfn_state_machine.wf_pipeline;
    expect(sm).toMatchObject({ name: "demo-dev-pipeline", role_arn: "${aws_iam_role.states.arn}", type: "STANDARD" });
    expect(sm.definition).toContain('"Resource": "${aws_lambda_function.step.arn}"');
    expect(sm.definition).not.toContain("__NSKIT_ARN_");
    const asl = JSON.parse(sm.definition.replaceAll("${aws_lambda_function.step.arn}", "ARN"));
    expect(asl.StartAt).toBe("First");
    expect(asl.States.First).toMatchObject({ Type: "Task", Resource: "ARN", Next: "Second", Parameters: { __nskit: "workflow", "data.$": "$" } });
    expect(asl.States.Second.End).toBe(true);
    const policy = res.aws_iam_role_policy.states_invoke.policy;
    expect(JSON.parse(policy.replaceAll("${", "{"))).toEqual({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: ["{aws_lambda_function.step.arn}", "{aws_lambda_function.step.arn}:*"] }],
    });
    expect(res.aws_lambda_function).not.toHaveProperty("pipeline_orchestrator");
  });

  it("uploads the artifact to S3 by default", () => {
    expect(res.aws_s3_bucket.nskit_artifacts).toEqual({
      bucket_prefix: "demo-dev-code-",
      force_destroy: true,
      tags: { "nskit-service": "demo", "nskit-stage": "dev", "managed-by": "node_serverless_kit" },
    });
    expect(res.aws_s3_bucket_public_access_block.nskit_artifacts.block_public_acls).toBe(true);
    expect(res.aws_s3_object.artifact).toEqual({
      bucket: "${aws_s3_bucket.nskit_artifacts.id}",
      key: "demo-dev/artifact-abababababababab.zip",
      source: "${path.module}/artifact.zip",
      source_hash: "ab".repeat(32),
    });
  });

  it("emits the nskit output", () => {
    const summary = out.output.nskit.value;
    expect(Object.keys(summary.functions).sort()).toEqual(["hello", "step", "tick", "worker"]);
    expect(summary.endpoint).toBe("${aws_apigatewayv2_api.http.api_endpoint}");
    expect(summary.functions.hello).toEqual({
      id: "${aws_lambda_function.hello.function_name}",
      arn: "${aws_lambda_function.hello.arn}",
      console: "https://eu-west-1.console.aws.amazon.com/lambda/home?region=eu-west-1#/functions/demo-dev-hello",
      base_url: "${aws_apigatewayv2_api.http.api_endpoint}",
    });
    expect(summary.functions.step).not.toHaveProperty("base_url");
    expect(summary.workflows.pipeline.id).toBe("${aws_sfn_state_machine.wf_pipeline.arn}");
    expect(summary.workflows.pipeline.console).toContain("states/home?region=eu-west-1");
    expect(out.output.nskit.description).toBe("node_serverless_kit deployment summary");
  });
});

describe("IAM", () => {
  it("creates per-function roles and escapes policy variables", () => {
    const out = tf(`
      service: svc
      provider:
        name: aws
        iam:
          statements:
            - {actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:*:*:table/\${aws:username}"]}
            - {effect: Deny, actions: ["dynamodb:PutItem"], resources: ["\${tf:aws_dynamodb_table.orders.arn}"]}
      functions:
        a:
          handler: src/handlers.worker
          iam: {statements: [{actions: ["s3:GetObject"]}]}
          options: {layers: ["arn:aws:lambda:us-east-1:1:layer:x:1"], tracing_config: {mode: Active}}
          concurrency: 5
          description: worker
          events:
            - queue: {name: existing-q, existing: true}
            - storage: {bucket: existing-b, existing: true}
            - topic: {name: existing-t, existing: true, filter: {kind: ["\${x}"]}}
        b:
          handler: src/handlers.hello
          iam: {role: "arn:aws:iam::123:role/existing"}
        c:
          handler: src/handlers.hello
    `);
    const res = out.resource;
    expect(res).not.toHaveProperty("aws_sqs_queue");
    expect(Object.keys(res.aws_s3_bucket)).toEqual(["nskit_artifacts"]);
    expect(Object.keys(out.data).sort()).toEqual(["aws_s3_bucket", "aws_sns_topic", "aws_sqs_queue"]);
    expect(out.data.aws_sqs_queue.q_existing_q).toEqual({ name: "existing-q" });
    expect(out.data.aws_s3_bucket.b_existing_b).toEqual({ bucket: "existing-b" });
    expect(res.aws_lambda_event_source_mapping["a_existing-q".replace("-", "_")].event_source_arn).toBe("${data.aws_sqs_queue.q_existing_q.arn}");
    expect(res.aws_s3_bucket_notification.b_existing_b.bucket).toBe("${data.aws_s3_bucket.b_existing_b.id}");
    expect(res.aws_sns_topic_subscription.a_existing_t.topic_arn).toBe("${data.aws_sns_topic.t_existing_t.arn}");
    expect(res.aws_sns_topic_subscription.a_existing_t.filter_policy).toBe('{"kind":["$${x}"]}');

    const fnA = res.aws_lambda_function.a;
    expect(fnA.role).toBe("${aws_iam_role.fn_a.arn}");
    expect(fnA.layers).toEqual(["arn:aws:lambda:us-east-1:1:layer:x:1"]);
    expect(fnA.tracing_config).toEqual({ mode: "Active" });
    expect(fnA.reserved_concurrent_executions).toBe(5);
    expect(fnA.description).toBe("worker");
    expect(res.aws_lambda_function.b.role).toBe("arn:aws:iam::123:role/existing");
    expect(res.aws_lambda_function.c.role).toBe("${aws_iam_role.lambda.arn}");
    expect(Object.keys(res.aws_iam_role).sort()).toEqual(["fn_a", "lambda"]);

    const policy: string = res.aws_iam_role_policy.fn_a_custom.policy;
    expect(policy).toContain("$${aws:username}");
    expect(policy).toContain('"${aws_dynamodb_table.orders.arn}"');
    const parsed = JSON.parse(policy.replace("$${aws:username}", "USER").replace("${aws_dynamodb_table.orders.arn}", "TABLE"));
    expect(parsed.Statement).toEqual([
      { Effect: "Allow", Action: ["dynamodb:GetItem"], Resource: ["arn:aws:dynamodb:*:*:table/USER"] },
      { Effect: "Deny", Action: ["dynamodb:PutItem"], Resource: ["TABLE"] },
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: ["*"] },
    ]);
    expect(res.aws_iam_role_policy.lambda_custom.policy).not.toContain("s3:GetObject");
    // the function role gets SQS execution because the function consumes a queue
    const attachments = Object.keys(res.aws_iam_role_policy_attachment).sort();
    expect(attachments).toEqual(["fn_a-basic", "fn_a-sqs", "lambda-basic", "lambda-sqs"].map((s) => s.replace("-", "_")));
  });

  it("uses an existing shared role", () => {
    const res = tf(`
      service: svc
      provider: {name: aws, iam: {role: "\${tf:aws_iam_role.mine.arn}"}}
      functions: {a: {handler: src/handlers.hello}}
    `).resource;
    expect(res).not.toHaveProperty("aws_iam_role");
    expect(res.aws_lambda_function.a.role).toBe("${aws_iam_role.mine.arn}");
  });
});

describe("HTTP auth and CORS", () => {
  it("supports iam and jwt auth", () => {
    const res = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a:
          handler: src/handlers.hello
          events:
            - http: {path: /iam, auth: iam}
            - http:
                path: /jwt
                method: POST
                auth: jwt
                authorizer: {issuer: "https://issuer.example", audience: my-api, scopes: [read, write]}
            - http:
                path: /jwt2
                auth: jwt
                authorizer: {issuer: "https://i2", audience: [a, b], identity_source: "$request.header.X-Token"}
    `).resource;
    const routes = res.aws_apigatewayv2_route;
    expect(routes.a_0).toMatchObject({ route_key: "GET /iam", authorization_type: "AWS_IAM" });
    expect(routes.a_1).toMatchObject({
      route_key: "POST /jwt",
      authorization_type: "JWT",
      authorizer_id: "${aws_apigatewayv2_authorizer.a-jwt-1.id}".replace("a-jwt-1", "a_jwt_1"),
      authorization_scopes: ["read", "write"],
    });
    expect(res.aws_apigatewayv2_authorizer.a_jwt_1).toEqual({
      api_id: "${aws_apigatewayv2_api.http.id}",
      authorizer_type: "JWT",
      name: "a-jwt-1",
      identity_sources: ["$request.header.Authorization"],
      jwt_configuration: { issuer: "https://issuer.example", audience: ["my-api"] },
    });
    expect(res.aws_apigatewayv2_authorizer.a_jwt_2.identity_sources).toEqual(["$request.header.X-Token"]);
    expect(res.aws_apigatewayv2_authorizer.a_jwt_2.jwt_configuration.audience).toEqual(["a", "b"]);
    expect(routes.a_2).not.toHaveProperty("authorization_scopes");
    expect(res.aws_apigatewayv2_api.http).not.toHaveProperty("cors_configuration");
  });

  it("merges CORS settings of all routes", () => {
    const res = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a:
          handler: src/handlers.hello
          timeout: 10
          events:
            - http: {path: /a, cors: {origins: ["https://b.example", "https://a.example"], methods: [GET], headers: [x-a], expose_headers: [x-id], max_age: 100}}
            - http: {path: /b, cors: {origins: ["https://a.example"], methods: [POST], allow_credentials: true, max_age: 50}}
    `).resource;
    expect(res.aws_apigatewayv2_api.http.cors_configuration).toEqual({
      allow_origins: ["https://a.example", "https://b.example"],
      allow_methods: ["GET", "POST"],
      allow_headers: ["*", "x-a"],
      expose_headers: ["x-id"],
      allow_credentials: true,
      max_age: 100,
    });
    expect(res.aws_apigatewayv2_integration.a.timeout_milliseconds).toBe(10000);
  });
});

describe("queues, schedules and buckets", () => {
  it("dead letter queues and FIFO", () => {
    const queues = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a:
          handler: src/handlers.worker
          timeout: 20
          events: [{queue: {name: orders, fifo: true, dead_letter: orders-dlq, max_receive: 3, batch_size: 5, batch_window: 10}}]
    `).resource;
    const main = queues.aws_sqs_queue.q_orders_fifo;
    expect(main).toMatchObject({ name: "orders.fifo", fifo_queue: true, content_based_deduplication: true, visibility_timeout_seconds: 120 });
    expect(main.redrive_policy).toBe('{"deadLetterTargetArn":"${aws_sqs_queue.q_orders-dlq_fifo.arn}","maxReceiveCount":3}'.replace("q_orders-dlq_fifo", "q_orders_dlq_fifo"));
    expect(queues.aws_sqs_queue.q_orders_dlq_fifo).toMatchObject({ name: "orders-dlq.fifo", fifo_queue: true });
    expect(queues.aws_lambda_event_source_mapping.a_orders).toMatchObject({ batch_size: 5, maximum_batching_window_in_seconds: 10 });
  });

  it("explicit visibility timeout and shared queues", () => {
    const res = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a: {handler: src/handlers.worker, events: [{queue: {name: jobs, visibility_timeout: 45}}]}
        b: {handler: src/handlers.worker, timeout: 1, events: [{queue: {name: jobs}}]}
    `).resource;
    expect(Object.keys(res.aws_sqs_queue)).toEqual(["q_jobs"]);
    expect(res.aws_sqs_queue.q_jobs.visibility_timeout_seconds).toBe(45);
    expect(Object.keys(res.aws_lambda_event_source_mapping).sort()).toEqual(["a_jobs", "b_jobs"]);
  });

  it("disabled, named and timezone schedules", () => {
    const res = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a:
          handler: src/handlers.tick
          events:
            - schedule: {rate: 1 hour, enabled: false, name: hourly, timezone: Europe/Berlin, input: {msg: "\${literal}"}}
    `).resource;
    const sched = res.aws_scheduler_schedule.a_0;
    expect(sched).toMatchObject({
      name: "svc-dev-a-hourly",
      state: "DISABLED",
      schedule_expression: "rate(1 hour)",
      schedule_expression_timezone: "Europe/Berlin",
    });
    expect(sched.target.input).toBe('{"__nskit":"schedule","data":{"msg":"$${literal}"},"source":"aws.scheduler"}');
  });

  it("groups notifications per bucket", () => {
    const res = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a: {handler: src/handlers.worker, events: [{storage: {bucket: shared-bkt, prefix: in/, events: [created, deleted]}}]}
        b: {handler: src/handlers.worker, events: [{storage: {bucket: shared-bkt, suffix: .png}}]}
    `).resource;
    expect(Object.keys(res.aws_s3_bucket_notification)).toEqual(["b_shared_bkt"]);
    const n = res.aws_s3_bucket_notification.b_shared_bkt;
    expect(n.lambda_function).toEqual([
      { lambda_function_arn: "${aws_lambda_function.a.arn}", events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"], filter_prefix: "in/" },
      { lambda_function_arn: "${aws_lambda_function.b.arn}", events: ["s3:ObjectCreated:*"], filter_suffix: ".png" },
    ]);
    expect(n.depends_on).toHaveLength(2);
  });

  it("one function may watch several prefixes of the same bucket", () => {
    const res = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a:
          handler: src/handlers.worker
          events:
            - storage: {bucket: bkt, prefix: in/}
            - storage: {bucket: bkt, prefix: out/}
    `).resource;
    expect(Object.keys(res.aws_lambda_permission)).toEqual(["a_s3_bkt"]);
    expect(res.aws_s3_bucket_notification.b_bkt.lambda_function.map((c: any) => c.filter_prefix)).toEqual(["in/", "out/"]);
    expect(res.aws_s3_bucket_notification.b_bkt.depends_on).toEqual(["aws_lambda_permission.a_s3_bkt"]);
  });
});

describe("options", () => {
  const yaml = (opts: string, extra = "") => `
    service: svc
    provider: {name: aws, options: {${opts}}${extra}}
    functions:
      a: {handler: src/handlers.hello}
  `;

  it("artifact_bucket uses an existing bucket", () => {
    const res = tf(yaml("artifact_bucket: my-deploys")).resource;
    expect(res).not.toHaveProperty("aws_s3_bucket");
    expect(res.aws_s3_object.artifact.bucket).toBe("my-deploys");
    expect(res.aws_s3_object.artifact.key).toBe("svc-dev/artifact-abababababababab.zip");
  });

  it("artifact_upload: direct uploads inline", () => {
    const res = tf(yaml("artifact_upload: direct")).resource;
    expect(res).not.toHaveProperty("aws_s3_object");
    expect(res).not.toHaveProperty("aws_s3_bucket");
    expect(res.aws_lambda_function.a.filename).toBe("${path.module}/artifact.zip");
    expect(res.aws_lambda_function.a).not.toHaveProperty("s3_bucket");
  });

  it("provider block options", () => {
    const out = tf(yaml("profile: dev, allowed_account_ids: ['123'], assume_role_arn: 'arn:aws:iam::1:role/deploy'"));
    expect(out.provider.aws[0]).toMatchObject({
      region: "us-east-1",
      profile: "dev",
      allowed_account_ids: ["123"],
      assume_role: { role_arn: "arn:aws:iam::1:role/deploy" },
    });
  });

  it("log retention can be disabled; runtime, memory, architecture are configurable", () => {
    const res = tf(yaml("", ", log_retention_days: null, runtime: '20', memory: 1024, architecture: arm64, timeout: 60")).resource;
    expect(res).not.toHaveProperty("aws_cloudwatch_log_group");
    expect(res.aws_lambda_function.a).not.toHaveProperty("depends_on");
    expect(res.aws_lambda_function.a).toMatchObject({ runtime: "nodejs20.x", memory_size: 1024, architectures: ["arm64"], timeout: 60 });
  });

  it("environment values are escaped except ${tf:...}", () => {
    const res = tf(`
      service: svc
      provider: {name: aws, environment: {TABLE: "\${tf:aws_dynamodb_table.t.name}", RAW: "\${not-a-var}", PCT: "%{x}"}}
      functions: {a: {handler: src/handlers.hello, environment: {RAW: "fn-\${x}"}}}
    `).resource;
    expect(res.aws_lambda_function.a.environment.variables).toMatchObject({
      TABLE: "${aws_dynamodb_table.t.name}",
      RAW: "fn-$${x}",
      PCT: "%%{x}",
    });
  });

  it("bundle_aws_sdk changes externals", () => {
    const p = new AwsProvider();
    expect(p.bundleTarget(project(yaml("")).config).external).toEqual(["@aws-sdk/*"]);
    expect(p.bundleTarget(project(yaml("bundle_aws_sdk: true")).config).external).toEqual([]);
    expect(p.entryCode({ config: {} as never, manifest: {} as never, runtime: (m) => `./rt/${m}` })).toBe('export { handler } from "./rt/adapters/aws";');
  });

  it("backend and terraform.extra", () => {
    const out = tf(`
      service: svc
      provider:
        name: aws
        state: {backend: s3, config: {bucket: tf-state, key: svc.tfstate, region: us-east-1}}
        terraform:
          provider_version: "~> 6.0"
          extra:
            resource:
              aws_dynamodb_table:
                orders: {name: orders, hash_key: id, billing_mode: PAY_PER_REQUEST, attribute: [{name: id, type: S}]}
    `);
    expect(out.terraform.backend.s3.bucket).toBe("tf-state");
    expect(out.terraform.required_providers.aws.version).toBe("~> 6.0");
    expect(out.resource.aws_dynamodb_table.orders.name).toBe("orders");
    expect(out.output.nskit.value).toEqual({ functions: {}, workflows: {}, endpoint: null });
  });
});

describe("workflows", () => {
  it("embedded engine on request adds an orchestrator function with an HTTP route", () => {
    const p = project(`
      service: svc
      provider: {name: aws}
      functions:
        step: {handler: src/handlers.step}
      workflows:
        wf:
          engine: embedded
          timeout: 120
          start_at: A
          states: {A: {type: task, function: step, end: true}}
    `);
    expect(p.engines).toEqual({ wf: "embedded" });
    const out = render(p);
    const fns = out.resource.aws_lambda_function;
    expect(fns).toHaveProperty("wf-orchestrator".replace("-", "_"));
    expect(fns.wf_orchestrator).toMatchObject({
      function_name: "svc-dev-wf-orchestrator",
      timeout: 120,
      description: "Embedded orchestrator for workflow wf",
      tags: expect.objectContaining({ "nskit-workflow": "wf" }),
    });
    expect(fns.wf_orchestrator.environment.variables.NSKIT_HANDLER).toBe("node_serverless_kit/workflow.orchestrate");
    expect(out.resource).not.toHaveProperty("aws_sfn_state_machine");
    expect(values(out.resource.aws_apigatewayv2_route).map((r) => r.route_key)).toEqual(["POST /workflows/wf"]);
    expect(out.output.nskit.value.workflows).toEqual({ wf: { id: "${aws_lambda_function.wf_orchestrator.function_name}" } });
  });

  it("options.http: false skips the orchestrator route", () => {
    const p = project(`
      service: svc
      provider: {name: aws}
      functions: {step: {handler: src/handlers.step}}
      workflows:
        wf: {engine: embedded, options: {http: false}, start_at: A, states: {A: {type: task, function: step}}}
    `);
    expect(p.config.functions["wf-orchestrator"].events).toEqual([]);
    expect(render(p).resource).not.toHaveProperty("aws_apigatewayv2_api");
  });

  it("mixes native and embedded workflows; escapes user strings but not ARNs; EXPRESS type", () => {
    const out = tf(`
      service: svc
      provider: {name: aws}
      functions:
        a-fn: {handler: src/handlers.step}
        b: {handler: src/handlers.step}
      workflows:
        native:
          description: "uses \${literal}"
          timeout: 300
          options: {type: express}
          start_at: P
          states:
            P: {type: pass, result: {tpl: "\${keep}"}, next: T}
            T: {type: task, function: a-fn, next: U}
            U: {type: task, function: b}
        emb:
          engine: embedded
          start_at: X
          states: {X: {type: task, function: b}}
    `);
    const sm = out.resource.aws_sfn_state_machine.wf_native;
    expect(sm.type).toBe("EXPRESS");
    expect(sm.definition).toContain('"Comment": "uses $${literal}"');
    expect(sm.definition).toContain('"tpl": "$${keep}"');
    expect(sm.definition).toContain('"Resource": "${aws_lambda_function.a-fn.arn}"'.replace("a-fn", "a_fn"));
    expect(sm.definition).toContain('"Resource": "${aws_lambda_function.b.arn}"');
    expect(sm.definition).toContain('"TimeoutSeconds": 300');
    const policy = out.resource.aws_iam_role_policy.states_invoke.policy;
    expect(policy).toContain("${aws_lambda_function.a_fn.arn}");
    expect(policy).toContain("${aws_lambda_function.b.arn}:*");
    expect(out.resource.aws_lambda_function).toHaveProperty("emb_orchestrator");
    expect(out.output.nskit.value.workflows.emb).toEqual({ id: "${aws_lambda_function.emb_orchestrator.function_name}" });
    expect(out.output.nskit.value.workflows.native.id).toBe("${aws_sfn_state_machine.wf_native.arn}");
  });
});

describe("validation", () => {
  const issuesOf = (yaml: string) =>
    makeProject(yaml)
      .load()
      .validate()
      .map((i) => ({ level: i.level, where: i.where, message: i.message }));

  it("API keys, missing jwt settings and long timeouts", () => {
    const issues = issuesOf(`
      service: svc
      provider: {name: aws}
      functions:
        a:
          handler: src/handlers.hello
          timeout: 1000
          events: [{http: {path: /x, auth: key}}, {http: {path: /y, auth: jwt, authorizer: {issuer: x}}}]
    `);
    const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
    expect(errors.some((e) => e.includes("API keys"))).toBe(true);
    expect(errors.some((e) => e.includes("jwt auth needs authorizer.issuer and authorizer.audience"))).toBe(true);
    expect(errors.some((e) => e.includes("timeout 1000s exceeds AWS Lambda max 900s"))).toBe(true);
  });

  it("artifact_upload must be s3 or direct", () => {
    const issues = issuesOf(`
      service: svc
      provider: {name: aws, options: {artifact_upload: ftp}}
      functions: {a: {handler: src/handlers.hello}}
    `);
    expect(issues).toContainEqual({ level: "error", where: "provider.options.artifact_upload", message: "artifact_upload must be 's3' or 'direct'" });
  });

  it("runtimes: default follows the provider; unsupported pins are errors", () => {
    const aws = getProvider("aws");
    expect(aws.defaultRuntime).toBe("nodejs22");
    const p = project("service: svc\nprovider: {name: aws}\nfunctions: {a: {handler: src/handlers.hello}}\n");
    expect(p.config.provider.runtime).toBe("nodejs22");
    expect(p.validate().filter((i) => i.level === "error")).toEqual([]);
    const pinned = issuesOf("service: svc\nprovider: {name: aws, runtime: '18'}\nfunctions: {a: {handler: src/handlers.hello, runtime: '24'}}\n");
    expect(pinned.find((i) => i.where === "provider.runtime")?.level).toBe("error");
    expect(pinned.find((i) => i.where === "functions.a.runtime")).toBeUndefined();
  });

  it("missing handler modules are reported", () => {
    const issues = issuesOf("service: svc\nprovider: {name: aws}\nfunctions: {a: {handler: src/nope.handler}}\n");
    expect(issues).toContainEqual(expect.objectContaining({ level: "error", where: "functions.a.handler" }));
  });
});
