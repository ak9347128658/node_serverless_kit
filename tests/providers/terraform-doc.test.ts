import { describe, expect, it } from "vitest";
import { escape, escapeMap, ref, TerraformDoc, tfId } from "../../src/providers/terraform-doc.js";

describe("helpers", () => {
  it.each([
    ["hello", "hello"],
    ["fn-a", "fn_a"],
    ["q-orders.fifo", "q_orders_fifo"],
    ["1abc", "_1abc"],
    ["-x", "_x"],
    ["_ok", "_ok"],
    ["a b/c", "a_b_c"],
  ])("tfId(%j) = %j", (input, expected) => {
    expect(tfId(input)).toBe(expected);
  });

  it("ref builds interpolations", () => {
    expect(ref("aws_lambda_function", "hello", "arn")).toBe("${aws_lambda_function.hello.arn}");
    expect(ref("var.x")).toBe("${var.x}");
  });

  it.each([
    ["plain", "plain"],
    ["${aws:username}", "$${aws:username}"],
    ["%{if x}", "%%{if x}"],
    ["a ${x} b ${y}", "a $${x} b $${y}"],
    ["${tf:aws_dynamodb_table.orders.arn}", "${aws_dynamodb_table.orders.arn}"],
    ["${ tf: aws_s3_bucket.b.id }", "${aws_s3_bucket.b.id}"],
    ["arn:${tf:aws_x.y.arn}/*:${aws:username}", "arn:${aws_x.y.arn}/*:$${aws:username}"],
    ["$${already}", "$$${already}"],
    ["cost: $5", "cost: $5"],
    ["$$ and $& and $1", "$$ and $& and $1"],
  ])("escape(%j) = %j", (input, expected) => {
    expect(escape(input)).toBe(expected);
  });

  it("escapeMap escapes every value", () => {
    expect(escapeMap({ A: "${x}", B: "${tf:a.b}", C: "c" })).toEqual({ A: "$${x}", B: "${a.b}", C: "c" });
  });
});

describe("TerraformDoc", () => {
  it("builds the terraform block, providers and backend", () => {
    const doc = new TerraformDoc();
    doc.requiredVersion(">= 1.5.0");
    doc.requiredProvider("aws", "hashicorp/aws", ">= 5.0");
    doc.requiredProvider("random", "hashicorp/random");
    doc.backend("s3", { bucket: "state" });
    doc.provider("aws", { region: "us-east-1" });
    doc.provider("aws", { region: "eu-west-1", alias: "eu" });
    expect(doc.toObject()).toEqual({
      terraform: {
        required_providers: { aws: { source: "hashicorp/aws", version: ">= 5.0" }, random: { source: "hashicorp/random" } },
        required_version: ">= 1.5.0",
        backend: { s3: { bucket: "state" } },
      },
      provider: { aws: [{ region: "us-east-1" }, { region: "eu-west-1", alias: "eu" }] },
    });
  });

  it("adds resources with sanitized labels and rejects duplicates", () => {
    const doc = new TerraformDoc();
    expect(doc.resource("aws_iam_role", "fn-a", { name: "x" })).toBe("aws_iam_role.fn_a");
    expect(doc.hasResource("aws_iam_role", "fn-a")).toBe(true);
    expect(doc.hasResource("aws_iam_role", "fn_a")).toBe(true);
    expect(doc.hasResource("aws_iam_role", "other")).toBe(false);
    expect(doc.hasResource("aws_nothing", "x")).toBe(false);
    expect(() => doc.resource("aws_iam_role", "fn_a", {})).toThrow("duplicate terraform resource aws_iam_role.fn_a");
    doc.resource("aws_iam_role", "b", {});
    doc.resource("aws_s3_bucket", "c", {});
    expect(doc.count()).toBe(3);
  });

  it("data sources: first definition wins", () => {
    const doc = new TerraformDoc();
    expect(doc.data("aws_sqs_queue", "q-1", { name: "one" })).toBe("data.aws_sqs_queue.q_1");
    doc.data("aws_sqs_queue", "q-1", { name: "two" });
    expect(doc.toObject().data).toEqual({ aws_sqs_queue: { q_1: { name: "one" } } });
    expect(doc.count()).toBe(0);
  });

  it("outputs, locals and variables", () => {
    const doc = new TerraformDoc();
    doc.output("nskit-summary", { a: 1 }, { description: "d", sensitive: true });
    doc.output("plain", "v");
    doc.local("prefix", "svc-dev");
    doc.variable("token", { type: "string", sensitive: true });
    const obj = doc.toObject();
    expect(obj.output).toEqual({ nskit_summary: { value: { a: 1 }, sensitive: true, description: "d" }, plain: { value: "v" } });
    expect(obj.locals).toEqual({ prefix: "svc-dev" });
    expect(obj.variable).toEqual({ token: { type: "string", sensitive: true } });
  });

  it("omits empty sections and orders keys", () => {
    const doc = new TerraformDoc();
    expect(doc.toObject()).toEqual({ terraform: { required_providers: {} } });
    doc.output("o", 1);
    doc.resource("r", "x", {});
    doc.data("d", "y", {});
    doc.local("l", 1);
    doc.variable("v", {});
    doc.provider("p", {});
    expect(Object.keys(doc.toObject())).toEqual(["terraform", "provider", "variable", "locals", "data", "resource", "output"]);
  });

  it("merges raw extra JSON deeply, last wins", () => {
    const doc = new TerraformDoc();
    doc.resource("aws_lambda_function", "f", { memory_size: 128, tags: { a: "1" } });
    doc.merge({ resource: { aws_lambda_function: { f: { memory_size: 512, tags: { b: "2" } } }, aws_dynamodb_table: { t: { name: "t" } } } });
    doc.merge({ terraform: { cloud: { organization: "o" } } });
    const obj = doc.toObject();
    expect(obj.resource.aws_lambda_function.f).toEqual({ memory_size: 512, tags: { a: "1", b: "2" } });
    expect(obj.resource.aws_dynamodb_table.t).toEqual({ name: "t" });
    expect(obj.terraform.cloud).toEqual({ organization: "o" });
    // merge does not mutate the doc's own state
    expect(doc.resources.aws_lambda_function.f.memory_size).toBe(128);
  });

  it("toJSON is pretty, deterministic and newline-terminated", () => {
    const doc = new TerraformDoc();
    doc.resource("r", "x", { a: 1 });
    const text = doc.toJSON();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "resource": {');
    expect(JSON.parse(text)).toEqual(doc.toObject());
    expect(doc.toJSON()).toBe(text);
  });

  it("starts with no warnings", () => {
    expect(new TerraformDoc().warnings).toEqual([]);
  });
});
