/**
 * Builder for Terraform JSON configuration (`main.tf.json`).
 *
 * Terraform reads `*.tf.json` natively. Generating JSON (instead of HCL text)
 * removes a whole class of quoting / escaping bugs.
 */

import { deepMerge } from "../config/loader.js";

const TF_REF = /\$\$\{\s*tf:([^}]+)\}/g;

/** Make a valid Terraform block label from an arbitrary logical name. */
export function tfId(name: string): string {
  let ident = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(ident)) ident = "_" + ident;
  return ident;
}

/** `ref("aws_lambda_function", "hello", "arn")` -> `${aws_lambda_function.hello.arn}`. */
export function ref(...parts: string[]): string {
  return "${" + parts.join(".") + "}";
}

/**
 * Escape literal `${` / `%{` so Terraform does not treat them as templates.
 *
 * The explicit `${tf:<expression>}` form is the one way to reference Terraform
 * from user values, e.g. `${tf:aws_dynamodb_table.orders.arn}` in an IAM
 * statement or environment variable.
 */
export function escape(value: string): string {
  // Replacer functions: in a replacement *string* "$$" would collapse to "$".
  const escaped = value.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
  return escaped.replace(TF_REF, (_m, expr: string) => "${" + expr.trim() + "}");
}

/** `escape` applied to every value of a string map. */
export function escapeMap(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escape(v)]));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export class TerraformDoc {
  terraform: Record<string, Json> = { required_providers: {} };
  providers: Record<string, Json[]> = {};
  resources: Record<string, Record<string, Json>> = {};
  dataSources: Record<string, Record<string, Json>> = {};
  outputs: Record<string, Json> = {};
  locals: Record<string, Json> = {};
  variables: Record<string, Json> = {};
  warnings: string[] = [];
  private extra: Record<string, Json> = {};

  // ----------------------------------------------------------------- blocks
  requiredProvider(name: string, source: string, version?: string | null): void {
    const spec: Record<string, string> = { source };
    if (version) spec.version = version;
    this.terraform.required_providers[name] = spec;
  }

  requiredVersion(constraint: string): void {
    this.terraform.required_version = constraint;
  }

  backend(kind: string, config: Record<string, Json>): void {
    this.terraform.backend = { [kind]: config };
  }

  provider(name: string, body: Record<string, Json>): void {
    (this.providers[name] ??= []).push(body);
  }

  /** Add a resource; returns its address (`type.label`). Duplicate labels are an error. */
  resource(type: string, name: string, body: Record<string, Json>): string {
    const bucket = (this.resources[type] ??= {});
    const label = tfId(name);
    if (label in bucket) throw new Error(`duplicate terraform resource ${type}.${label}`);
    bucket[label] = body;
    return `${type}.${label}`;
  }

  hasResource(type: string, name: string): boolean {
    return tfId(name) in (this.resources[type] ?? {});
  }

  /** Add a data source (first definition wins); returns its address. */
  data(type: string, name: string, body: Record<string, Json>): string {
    const bucket = (this.dataSources[type] ??= {});
    const label = tfId(name);
    if (!(label in bucket)) bucket[label] = body;
    return `data.${type}.${label}`;
  }

  output(name: string, value: Json, options: { sensitive?: boolean; description?: string } = {}): void {
    const body: Record<string, Json> = { value };
    if (options.sensitive) body.sensitive = true;
    if (options.description) body.description = options.description;
    this.outputs[tfId(name)] = body;
  }

  local(name: string, value: Json): void {
    this.locals[name] = value;
  }

  variable(name: string, body: Record<string, Json>): void {
    this.variables[name] = body;
  }

  /** Deep-merge user supplied raw Terraform JSON (escape hatch). */
  merge(extra: Record<string, Json>): void {
    this.extra = deepMerge(this.extra, extra) as Record<string, Json>;
  }

  // ----------------------------------------------------------------- output
  toObject(): Record<string, Json> {
    let doc: Record<string, Json> = { terraform: this.terraform };
    if (Object.keys(this.providers).length) doc.provider = this.providers;
    if (Object.keys(this.variables).length) doc.variable = this.variables;
    if (Object.keys(this.locals).length) doc.locals = this.locals;
    if (Object.keys(this.dataSources).length) doc.data = this.dataSources;
    if (Object.keys(this.resources).length) doc.resource = this.resources;
    if (Object.keys(this.outputs).length) doc.output = this.outputs;
    if (Object.keys(this.extra).length) doc = deepMerge(doc, this.extra) as Record<string, Json>;
    return doc;
  }

  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2) + "\n";
  }

  count(): number {
    return Object.values(this.resources).reduce((n, bucket) => n + Object.keys(bucket).length, 0);
  }
}
