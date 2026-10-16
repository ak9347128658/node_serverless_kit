/**
 * AWS: Lambda + API Gateway HTTP API + EventBridge Scheduler + SQS + S3 + SNS + Step Functions.
 *
 * Options (`provider.options`): `profile`, `allowed_account_ids`, `assume_role_arn`,
 * `artifact_bucket` (existing bucket for code uploads), `artifact_upload: s3 | direct`,
 * `bundle_aws_sdk` (bundle `@aws-sdk/*` instead of using the copy in the Lambda runtime).
 * Per-function `options` are merged into `aws_lambda_function` (vpc_config, layers, ...).
 */

import {
  corsOf,
  eventsOf,
  type FunctionConfig,
  type HttpEvent,
  type IamStatement,
  type QueueEvent,
  type ScheduleEvent,
  type ServiceConfig,
  type StorageEvent,
  type TopicEvent,
} from "../config/schema.js";
import { envelope } from "../runtime/envelope.js";
import { definitionData } from "../workflows/index.js";
import { compileAsl } from "../workflows/asl.js";
import { taskFunctions } from "../config/schema.js";
import {
  HTTP,
  Issue,
  Provider,
  QUEUE,
  SCHEDULE,
  STORAGE,
  TOPIC,
  WORKFLOW_NATIVE,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import * as sched from "./schedule.js";
import { escape, escapeMap, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const LAMBDA = "aws_lambda_function";
const BASIC_EXEC = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const SQS_EXEC = "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole";

function assume(service: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
  });
}

function policy(statements: Record<string, unknown>[]): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

const PUBLIC_ACCESS_BLOCK = {
  block_public_acls: true,
  block_public_policy: true,
  ignore_public_acls: true,
  restrict_public_buckets: true,
};

export class AwsProvider extends Provider {
  readonly name = "aws";
  readonly displayName = "AWS Lambda";
  override readonly tier = "stable";
  readonly terraformSource = "hashicorp/aws";
  override readonly terraformVersion = ">= 5.40";
  override readonly defaultRegion = "us-east-1";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, QUEUE, STORAGE, TOPIC, WORKFLOW_NATIVE]);
  override readonly maxNameLength = 64;
  override readonly namePattern = /[^a-z0-9_-]/g;
  override readonly runtimes = { nodejs20: "nodejs20.x", nodejs22: "nodejs22.x", nodejs24: "nodejs24.x" };
  override readonly maxTimeout = 900;
  override readonly notes = "HTTP via API Gateway HTTP API; schedules via EventBridge Scheduler; workflows via Step Functions.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js", external: ["@aws-sdk/*"] };

  override bundleTarget(config: ServiceConfig): BundleTarget {
    if (config.provider.options.bundle_aws_sdk) return { ...this.bundle, external: [] };
    return this.bundle;
  }

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    return `export { handler } from ${JSON.stringify(ctx.runtime("adapters/aws"))};`;
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { region: ctx.region, default_tags: { tags: ctx.tags() } };
    for (const key of ["profile", "allowed_account_ids"]) if (ctx.opt(key)) block[key] = ctx.opt(key);
    if (ctx.opt("assume_role_arn")) block.assume_role = { role_arn: ctx.opt("assume_role_arn") };
    return block;
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    const upload = config.provider.options.artifact_upload ?? "s3";
    if (upload !== "s3" && upload !== "direct") {
      issues.push(new Issue("error", "artifact_upload must be 's3' or 'direct'", "provider.options.artifact_upload"));
    }
    for (const [name, fn] of Object.entries(config.functions)) {
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth === "key") {
          issues.push(new Issue("error", "API keys are not available on API Gateway HTTP APIs; use jwt or iam", `functions.${name}`));
        }
        if (ev.auth === "jwt" && !("issuer" in ev.authorizer && "audience" in ev.authorizer)) {
          issues.push(new Issue("error", "jwt auth needs authorizer.issuer and authorizer.audience", `functions.${name}`));
        }
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const has = new Set(Object.values(cfg.functions).flatMap((fn) => fn.events.map((e) => e.type)));
    const sharedRole = this.role(doc, ctx, "lambda", cfg.provider.iam.statements, has.has("queue"), cfg.provider.iam.role);
    const code = this.codeSource(doc, ctx);

    const fnOut: Record<string, Record<string, unknown>> = {};
    const arns: Record<string, string> = {};
    let api: string | undefined;
    const s3Notifications = new Map<string, [string, StorageEvent][]>();

    for (const [name, fn] of ctx.functionItems()) {
      let role = sharedRole;
      if (fn.iam.statements.length || fn.iam.role) {
        role = this.role(
          doc,
          ctx,
          `fn-${name}`,
          [...cfg.provider.iam.statements, ...fn.iam.statements],
          eventsOf(fn, "queue").length > 0,
          fn.iam.role,
        );
      }
      const lam = this.lambda(doc, ctx, name, fn, role, code);
      arns[name] = ref(lam, "arn");
      const out: Record<string, unknown> = {
        id: ref(lam, "function_name"),
        arn: ref(lam, "arn"),
        console: `https://${ctx.region}.console.aws.amazon.com/lambda/home?region=${ctx.region}#/functions/${ctx.physicalName(name)}`,
      };
      const httpEvents = eventsOf(fn, "http");
      if (httpEvents.length) {
        api ??= this.api(doc, ctx);
        this.http(doc, ctx, api, name, fn, lam, httpEvents);
        out.base_url = ref(api, "api_endpoint");
      }
      eventsOf(fn, "schedule").forEach((ev, i) => this.schedule(doc, ctx, name, lam, i, ev));
      for (const ev of eventsOf(fn, "queue")) this.queue(doc, ctx, name, fn, lam, ev);
      for (const ev of eventsOf(fn, "storage")) {
        const list = s3Notifications.get(ev.bucket) ?? [];
        list.push([name, ev]);
        s3Notifications.set(ev.bucket, list);
      }
      for (const ev of eventsOf(fn, "topic")) this.topic(doc, ctx, name, lam, ev);
      fnOut[name] = out;
    }

    for (const [bucket, subs] of [...s3Notifications.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      this.bucketNotifications(doc, ctx, bucket, subs, arns);
    }

    const wfOut = this.workflows(doc, ctx, arns);
    doc.output(
      "nskit",
      { functions: fnOut, workflows: wfOut, endpoint: api ? ref(api, "api_endpoint") : null },
      { description: "node-serverless-kit deployment summary" },
    );
  }

  // ------------------------------------------------------------------ pieces
  /** Returns a Terraform expression for the role ARN. */
  private role(
    doc: TerraformDoc,
    ctx: RenderContext,
    label: string,
    statements: IamStatement[],
    sqs: boolean,
    existing?: string | null,
  ): string {
    if (existing) return escape(existing);
    const role = doc.resource("aws_iam_role", label, {
      name: ctx.physicalName(label).slice(0, 64),
      assume_role_policy: assume("lambda.amazonaws.com"),
    });
    doc.resource("aws_iam_role_policy_attachment", `${label}-basic`, { role: ref(role, "name"), policy_arn: BASIC_EXEC });
    if (sqs) doc.resource("aws_iam_role_policy_attachment", `${label}-sqs`, { role: ref(role, "name"), policy_arn: SQS_EXEC });
    if (statements.length) {
      doc.resource("aws_iam_role_policy", `${label}-custom`, {
        name: "nskit-custom",
        role: ref(role, "id"),
        policy: escape(policy(statements.map((s) => ({ Effect: s.effect, Action: s.actions, Resource: s.resources })))),
      });
    }
    return ref(role, "arn");
  }

  /**
   * Where Lambda gets its code from. By default the artifact is uploaded once
   * to S3 and every function points at it: sending the zip inline puts the
   * whole base64 payload in each CreateFunction request, which fails for large
   * bundles and is capped at 50 MB. `options.artifact_upload: direct` restores
   * the inline upload.
   */
  private codeSource(doc: TerraformDoc, ctx: RenderContext): Record<string, unknown> {
    if (ctx.opt<string>("artifact_upload", "s3") === "direct") return { filename: "${path.module}/artifact.zip" };
    let bucket: string;
    const existing = ctx.opt<string | undefined>("artifact_bucket");
    if (existing) {
      bucket = escape(String(existing));
    } else {
      const label = "nskit-artifacts";
      const prefix =
        ctx.prefix
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 30)
          .replace(/-+$/, "") || "nskit";
      const b = doc.resource("aws_s3_bucket", label, { bucket_prefix: `${prefix}-code-`, force_destroy: true, tags: ctx.tags() });
      doc.resource("aws_s3_bucket_public_access_block", label, { bucket: ref(b, "id"), ...PUBLIC_ACCESS_BLOCK });
      bucket = ref(b, "id");
    }
    const obj = doc.resource("aws_s3_object", "artifact", {
      bucket,
      key: `${ctx.prefix}/artifact-${ctx.artifact.sha256.slice(0, 16)}.zip`,
      source: "${path.module}/artifact.zip",
      source_hash: ctx.artifact.sha256,
    });
    return { s3_bucket: ref(obj, "bucket"), s3_key: ref(obj, "key") };
  }

  private lambda(
    doc: TerraformDoc,
    ctx: RenderContext,
    name: string,
    fn: FunctionConfig,
    roleArn: string,
    code: Record<string, unknown>,
  ): string {
    const cfg = ctx.config;
    const phys = ctx.physicalName(name);
    const dependsOn: string[] = [];
    if (cfg.provider.logRetentionDays) {
      dependsOn.push(
        doc.resource("aws_cloudwatch_log_group", `logs-${name}`, {
          name: `/aws/lambda/${phys}`,
          retention_in_days: cfg.provider.logRetentionDays,
        }),
      );
    }
    const body: Record<string, unknown> = {
      function_name: phys,
      description: fn.description.slice(0, 256),
      role: roleArn,
      handler: `${ctx.artifact.entryFile.replace(/\.[cm]?js$/, "")}.handler`,
      runtime: ctx.runtimeIdOf(fn),
      ...code,
      source_code_hash: ctx.artifact.sha256Base64,
      memory_size: ctx.memoryOf(fn),
      timeout: ctx.timeoutOf(fn),
      architectures: [ctx.architectureOf(fn)],
      environment: { variables: escapeMap(ctx.environment(name, fn)) },
      tags: ctx.tags(fn),
    };
    if (fn.concurrency !== null && fn.concurrency !== undefined) body.reserved_concurrent_executions = fn.concurrency;
    if (dependsOn.length) body.depends_on = dependsOn;
    Object.assign(body, fn.options); // escape hatch: vpc_config, layers, tracing_config, ...
    return doc.resource(LAMBDA, name, body);
  }

  private api(doc: TerraformDoc, ctx: RenderContext): string {
    const corsConfigs = Object.values(ctx.config.functions)
      .flatMap((fn) => eventsOf(fn, "http"))
      .map(corsOf)
      .filter((c) => c !== undefined);
    const body: Record<string, unknown> = { name: ctx.prefix, protocol_type: "HTTP", tags: ctx.tags() };
    if (corsConfigs.length) {
      const uniq = (values: string[]) => [...new Set(values)].sort();
      body.cors_configuration = {
        allow_origins: uniq(corsConfigs.flatMap((c) => c.origins)),
        allow_methods: uniq(corsConfigs.flatMap((c) => c.methods ?? ["*"])),
        allow_headers: uniq(corsConfigs.flatMap((c) => c.headers ?? ["*"])),
        expose_headers: uniq(corsConfigs.flatMap((c) => c.exposeHeaders)),
        allow_credentials: corsConfigs.some((c) => c.allowCredentials),
        max_age: Math.max(...corsConfigs.map((c) => c.maxAge)),
      };
    }
    const api = doc.resource("aws_apigatewayv2_api", "http", body);
    doc.resource("aws_apigatewayv2_stage", "default", { api_id: ref(api, "id"), name: "$default", auto_deploy: true, tags: ctx.tags() });
    return api;
  }

  private http(doc: TerraformDoc, ctx: RenderContext, api: string, name: string, fn: FunctionConfig, lam: string, events: HttpEvent[]): void {
    const integ = doc.resource("aws_apigatewayv2_integration", name, {
      api_id: ref(api, "id"),
      integration_type: "AWS_PROXY",
      integration_uri: ref(lam, "invoke_arn"),
      payload_format_version: "2.0",
      timeout_milliseconds: Math.min(30000, ctx.timeoutOf(fn) * 1000),
    });
    events.forEach((ev, i) => {
      const route: Record<string, unknown> = {
        api_id: ref(api, "id"),
        route_key: `${ev.method} ${ev.path}`,
        target: "integrations/" + ref(integ, "id"),
      };
      if (ev.auth === "iam") {
        route.authorization_type = "AWS_IAM";
      } else if (ev.auth === "jwt") {
        const audience = ev.authorizer.audience;
        const authz = doc.resource("aws_apigatewayv2_authorizer", `${name}-jwt-${i}`, {
          api_id: ref(api, "id"),
          authorizer_type: "JWT",
          name: `${name}-jwt-${i}`,
          identity_sources: [String(ev.authorizer.identity_source ?? ev.authorizer.identitySource ?? "$request.header.Authorization")],
          jwt_configuration: {
            issuer: String(ev.authorizer.issuer),
            audience: Array.isArray(audience) ? audience.map(String) : [String(audience)],
          },
        });
        route.authorization_type = "JWT";
        route.authorizer_id = ref(authz, "id");
        if (Array.isArray(ev.authorizer.scopes)) route.authorization_scopes = ev.authorizer.scopes.map(String);
      }
      doc.resource("aws_apigatewayv2_route", `${name}-${i}`, route);
    });
    doc.resource("aws_lambda_permission", `${name}-apigw`, {
      statement_id: "AllowAPIGatewayInvoke",
      action: "lambda:InvokeFunction",
      function_name: ref(lam, "function_name"),
      principal: "apigateway.amazonaws.com",
      source_arn: ref(api, "execution_arn") + "/*/*",
    });
  }

  private schedulerRole(doc: TerraformDoc, ctx: RenderContext): string {
    if (!doc.hasResource("aws_iam_role", "scheduler")) {
      const role = doc.resource("aws_iam_role", "scheduler", {
        name: ctx.physicalName("scheduler").slice(0, 64),
        assume_role_policy: assume("scheduler.amazonaws.com"),
      });
      doc.resource("aws_iam_role_policy", "scheduler-invoke", {
        name: "invoke-lambda",
        role: ref(role, "id"),
        policy: policy([{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: "*" }]),
      });
    }
    return ref("aws_iam_role", "scheduler", "arn");
  }

  private schedule(doc: TerraformDoc, ctx: RenderContext, name: string, lam: string, i: number, ev: ScheduleEvent): void {
    const role = this.schedulerRole(doc, ctx);
    doc.resource("aws_scheduler_schedule", `${name}-${i}`, {
      name: ctx.physicalName(`${name}-${ev.name ?? i}`).slice(0, 64),
      group_name: "default",
      schedule_expression: sched.awsExpression(ev),
      schedule_expression_timezone: ev.timezone,
      state: ev.enabled ? "ENABLED" : "DISABLED",
      flexible_time_window: { mode: "OFF" },
      target: {
        arn: ref(lam, "arn"),
        role_arn: role,
        input: escape(JSON.stringify(envelope("schedule", ev.input ?? null, { source: "aws.scheduler" }))),
        retry_policy: { maximum_retry_attempts: 2 },
      },
    });
  }

  private queueRef(doc: TerraformDoc, ctx: RenderContext, ev: QueueEvent, timeout: number): string {
    const fifo = (n: string) => n + (ev.fifo && !n.endsWith(".fifo") ? ".fifo" : "");
    const qname = fifo(ev.name);
    const label = `q-${qname}`;
    if (ev.existing) return doc.data("aws_sqs_queue", label, { name: qname });
    if (!doc.hasResource("aws_sqs_queue", label)) {
      const body: Record<string, unknown> = {
        name: qname,
        visibility_timeout_seconds: ev.visibilityTimeout ?? Math.max(30, timeout * 6),
        message_retention_seconds: 1209600,
        tags: ctx.tags(),
      };
      if (ev.fifo) {
        body.fifo_queue = true;
        body.content_based_deduplication = true;
      }
      if (ev.deadLetter) {
        const dlqName = fifo(ev.deadLetter);
        const dlqLabel = `q-${dlqName}`;
        if (!doc.hasResource("aws_sqs_queue", dlqLabel)) {
          const dlq: Record<string, unknown> = { name: dlqName, message_retention_seconds: 1209600, tags: ctx.tags() };
          if (ev.fifo) dlq.fifo_queue = true;
          doc.resource("aws_sqs_queue", dlqLabel, dlq);
        }
        body.redrive_policy =
          '{"deadLetterTargetArn":"' + ref("aws_sqs_queue", tfId(dlqLabel), "arn") + `","maxReceiveCount":${ev.maxReceive}}`;
      }
      doc.resource("aws_sqs_queue", label, body);
    }
    return `aws_sqs_queue.${tfId(label)}`;
  }

  private queue(doc: TerraformDoc, ctx: RenderContext, name: string, fn: FunctionConfig, lam: string, ev: QueueEvent): void {
    const q = this.queueRef(doc, ctx, ev, ctx.timeoutOf(fn));
    const body: Record<string, unknown> = {
      event_source_arn: ref(q, "arn"),
      function_name: ref(lam, "arn"),
      batch_size: ev.batchSize,
      function_response_types: ["ReportBatchItemFailures"],
    };
    if (ev.batchWindow) body.maximum_batching_window_in_seconds = ev.batchWindow;
    doc.resource("aws_lambda_event_source_mapping", `${name}-${ev.name}`, body);
  }

  private bucketNotifications(
    doc: TerraformDoc,
    ctx: RenderContext,
    bucket: string,
    subs: [string, StorageEvent][],
    arns: Record<string, string>,
  ): void {
    const label = `b-${bucket}`;
    let bucketRef: string;
    if (subs.some(([, ev]) => !ev.existing)) {
      if (!doc.hasResource("aws_s3_bucket", label)) {
        const b = doc.resource("aws_s3_bucket", label, { bucket, tags: ctx.tags() });
        doc.resource("aws_s3_bucket_public_access_block", label, { bucket: ref(b, "id"), ...PUBLIC_ACCESS_BLOCK });
      }
      bucketRef = `aws_s3_bucket.${tfId(label)}`;
    } else {
      bucketRef = doc.data("aws_s3_bucket", label, { bucket });
    }
    const perms: string[] = [];
    const configs: Record<string, unknown>[] = [];
    for (const [fname, ev] of subs) {
      // One permission per function and bucket, even with several notifications (e.g. two prefixes).
      if (!doc.hasResource("aws_lambda_permission", `${fname}-s3-${bucket}`)) {
        perms.push(
          doc.resource("aws_lambda_permission", `${fname}-s3-${bucket}`, {
            statement_id: `AllowS3-${tfId(bucket)}`,
            action: "lambda:InvokeFunction",
            function_name: arns[fname],
            principal: "s3.amazonaws.com",
            source_arn: ref(bucketRef, "arn"),
          }),
        );
      }
      const entry: Record<string, unknown> = {
        lambda_function_arn: arns[fname],
        events: ev.events.map((e) => (e === "created" ? "s3:ObjectCreated:*" : "s3:ObjectRemoved:*")),
      };
      if (ev.prefix) entry.filter_prefix = ev.prefix;
      if (ev.suffix) entry.filter_suffix = ev.suffix;
      configs.push(entry);
    }
    doc.resource("aws_s3_bucket_notification", label, { bucket: ref(bucketRef, "id"), lambda_function: configs, depends_on: perms });
  }

  private topic(doc: TerraformDoc, ctx: RenderContext, name: string, lam: string, ev: TopicEvent): void {
    const label = `t-${ev.name}`;
    let topic: string;
    if (ev.existing) {
      topic = doc.data("aws_sns_topic", label, { name: ev.name });
    } else {
      if (!doc.hasResource("aws_sns_topic", label)) doc.resource("aws_sns_topic", label, { name: ev.name, tags: ctx.tags() });
      topic = `aws_sns_topic.${tfId(label)}`;
    }
    const sub: Record<string, unknown> = { topic_arn: ref(topic, "arn"), protocol: "lambda", endpoint: ref(lam, "arn") };
    if (ev.filter) sub.filter_policy = escape(JSON.stringify(ev.filter));
    doc.resource("aws_sns_topic_subscription", `${name}-${ev.name}`, sub);
    doc.resource("aws_lambda_permission", `${name}-sns-${ev.name}`, {
      statement_id: `AllowSNS-${tfId(ev.name)}`,
      action: "lambda:InvokeFunction",
      function_name: ref(lam, "function_name"),
      principal: "sns.amazonaws.com",
      source_arn: ref(topic, "arn"),
    });
  }

  private workflows(doc: TerraformDoc, ctx: RenderContext, arns: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const all = Object.entries(ctx.config.workflows).sort(([a], [b]) => (a < b ? -1 : 1));
    const native = all.filter(([n]) => ctx.workflowEngines[n] === "native");
    const orchestratorOut = (n: string) => ({ id: ref(LAMBDA, tfId(`${n}-orchestrator`), "function_name") });
    if (!native.length) {
      for (const [n] of all) out[n] = orchestratorOut(n);
      return out;
    }
    const role = doc.resource("aws_iam_role", "states", {
      name: ctx.physicalName("states").slice(0, 64),
      assume_role_policy: assume("states.amazonaws.com"),
    });
    const used = [...new Set(native.flatMap(([, wf]) => taskFunctions(wf)))].sort();
    doc.resource("aws_iam_role_policy", "states-invoke", {
      name: "invoke-tasks",
      role: ref(role, "id"),
      policy:
        '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":[' +
        used.map((f) => `"${arns[f]}","${arns[f]}:*"`).join(",") +
        "]}]}",
    });
    const nativeNames = new Set(native.map(([n]) => n));
    for (const [name, wf] of all) {
      if (!nativeNames.has(name)) {
        out[name] = orchestratorOut(name);
        continue;
      }
      // Placeholders keep Terraform references out of `escape`, then are swapped in.
      const fnNames = Object.keys(arns).sort();
      const placeholder = (f: string) => `__NSKIT_ARN_${fnNames.indexOf(f)}__`;
      const asl = compileAsl(definitionData(wf), placeholder, wf.description, wf.timeout ?? 0);
      let text = escape(JSON.stringify(asl, null, 2));
      for (const f of fnNames) text = text.split(placeholder(f)).join(arns[f]);
      const sm = doc.resource("aws_sfn_state_machine", `wf-${name}`, {
        name: ctx.physicalName(name).slice(0, 80),
        role_arn: ref(role, "arn"),
        type: String(wf.options.type ?? "STANDARD").toUpperCase(),
        definition: text,
        tags: ctx.tags(),
      });
      out[name] = {
        id: ref(sm, "arn"),
        console: `https://${ctx.region}.console.aws.amazon.com/states/home?region=${ctx.region}#/statemachines/view/${ref(sm, "arn")}`,
      };
    }
    return out;
  }
}
