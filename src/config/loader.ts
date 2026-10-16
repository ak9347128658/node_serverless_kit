/**
 * Load, merge and interpolate `nskit.yml`.
 *
 * Resolution order (later wins):
 *
 * 1. `extends: other.yml`        - parent file(s), deep-merged
 * 2. the file itself
 * 3. `providers.<provider>:`     - per-cloud overrides of any top-level key
 * 4. `stages.<stage>:`           - per-stage overrides of any top-level key
 * 5. CLI flags (`--provider`, `--stage`, `--region`)
 *
 * Then variables are interpolated:
 *
 * - `${env:NAME}` / `${env:NAME, default}`             - environment variable
 * - `${opt:stage}` / `${opt:region}` / `${opt:provider}` - effective CLI values
 * - `${self:dotted.path}`                              - any value in the merged config
 * - `${file(path/to/file.json)}` / `.yml` / `.txt`     - file content (relative to the config)
 *
 * `${tf:aws_dynamodb_table.orders.arn}` is left for Terraform (see
 * providers/terraform-doc `escape`), and any other `${...}` (e.g. IAM policy
 * variables like `${aws:username}`) is kept verbatim.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { camelCase, PROVIDERS, ServiceConfigSchema, type ServiceConfig } from "./schema.js";

export const DEFAULT_FILES = ["nskit.yml", "nskit.yaml", "serverless-kit.yml", "serverless-kit.yaml"];
// Only these sources are resolved here. Anything else - IAM policy variables such
// as ${aws:username}, or ${tf:resource.attr} Terraform references - is kept as is.
const VAR_SOURCE = String.raw`\$\{\s*(env|opt|self|file)(?::([^}]*)|\(([^)]*)\))\s*\}`;
const MAX_PASSES = 10;

/** User-facing configuration problem. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  config: ServiceConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Directory containing the config file. */
  root: string;
  /** The merged, interpolated document before validation. */
  raw: Record<string, unknown>;
}

export interface LoadOptions {
  provider?: string;
  stage?: string;
  region?: string;
  cwd?: string;
  /** Extra provider names accepted besides the built-ins (plug-ins). */
  knownProviders?: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (isObj(base) && isObj(override)) {
    const out: Obj = { ...base };
    for (const [k, v] of Object.entries(override)) out[k] = k in base ? deepMerge(base[k], v) : clone(v);
    return out;
  }
  return clone(override);
}

export function findConfig(file?: string, cwd: string = process.cwd()): string {
  if (file) {
    const candidate = path.resolve(cwd, file);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new ConfigError(`config file not found: ${candidate}`);
    return candidate;
  }
  for (const name of DEFAULT_FILES) {
    const candidate = path.join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new ConfigError(`no config found in ${cwd} (looked for ${DEFAULT_FILES.join(", ")}); run \`nskit init\``);
}

function readYaml(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, "utf-8"));
  } catch (err) {
    if (err instanceof YAMLParseError) throw new ConfigError(`invalid YAML in ${file}: ${err.message}`);
    throw err;
  }
}

/** The file and its `extends` ancestors as layers, parents first. */
function readLayers(file: string, chain: string[] = []): Obj[] {
  if (chain.includes(file)) throw new ConfigError("circular `extends`: " + [...chain, file].join(" -> "));
  const data = readYaml(file) ?? {};
  if (!isObj(data)) throw new ConfigError(`${file} must contain a mapping at the top level`);
  const parents = data.extends;
  delete data.extends;
  const layers: Obj[] = [];
  const list = typeof parents === "string" ? [parents] : Array.isArray(parents) ? parents : [];
  for (const parent of list) layers.push(...readLayers(path.resolve(path.dirname(file), String(parent)), [...chain, file]));
  if (typeof data.provider === "string") data.provider = { name: data.provider };
  layers.push(data);
  return layers;
}

const PROVIDER_FIELDS = new Set([
  "region",
  "stage",
  "runtime",
  "memory",
  "timeout",
  "architecture",
  "environment",
  "tags",
  "iam",
  "logRetentionDays",
  "options",
  "state",
  "terraform",
]);

/**
 * `providers.<cloud>` block -> top-level override. ProviderConfig keys may be
 * written directly (`region: x`) as shorthand for `provider: {region: x}`.
 */
function providerOverride(block: unknown): Obj {
  const rest: Obj = { ...(isObj(block) ? block : {}) };
  const short: Obj = {};
  for (const key of Object.keys(rest)) {
    if (PROVIDER_FIELDS.has(camelCase(key))) {
      short[key] = rest[key];
      delete rest[key];
    }
  }
  return Object.keys(short).length ? (deepMerge(rest, { provider: short }) as Obj) : rest;
}

function lookup(data: unknown, dotted: string): unknown {
  let current: unknown = data;
  for (const part of dotted.split(".")) {
    if (isObj(current) && part in current) current = current[part];
    else if (Array.isArray(current) && /^\d+$/.test(part) && Number(part) < current.length) current = current[Number(part)];
    else throw new MissingVar(`self:${dotted}`);
  }
  return current;
}

class MissingVar extends Error {}

function stripQuotes(text: string): string {
  if (text.length >= 2 && text[0] === text[text.length - 1] && (text[0] === "'" || text[0] === '"')) return text.slice(1, -1);
  return text;
}

function splitDefault(arg: string): [string, string | undefined] {
  const idx = arg.indexOf(",");
  if (idx < 0) return [arg.trim(), undefined];
  return [arg.slice(0, idx).trim(), stripQuotes(arg.slice(idx + 1).trim())];
}

class Interpolator {
  readonly unresolved: string[] = [];

  constructor(
    private readonly root: Obj,
    private readonly opts: Record<string, string>,
    private readonly baseDir: string,
  ) {}

  resolveVar(kind: string, rawArg: string): unknown {
    const arg = (rawArg ?? "").trim();
    if (kind === "env") {
      const [name, fallback] = splitDefault(arg);
      if (process.env[name] !== undefined) return process.env[name];
      if (fallback !== undefined) return fallback;
      throw new MissingVar(`env:${name}`);
    }
    if (kind === "opt") {
      const [name, fallback] = splitDefault(arg);
      if (name in this.opts) return this.opts[name];
      if (fallback !== undefined) return fallback;
      throw new MissingVar(`opt:${name}`);
    }
    if (kind === "self") {
      const [name, fallback] = splitDefault(arg);
      try {
        return lookup(this.root, name);
      } catch (err) {
        if (fallback !== undefined) return fallback;
        throw err;
      }
    }
    if (kind === "file") {
      const target = path.resolve(this.baseDir, stripQuotes(arg));
      if (!existsSync(target)) throw new ConfigError(`\${file(${arg})}: ${target} does not exist`);
      const text = readFileSync(target, "utf-8");
      const ext = path.extname(target).toLowerCase();
      if (ext === ".json") return JSON.parse(text);
      if (ext === ".yml" || ext === ".yaml") return parseYaml(text);
      return text.trim();
    }
    throw new ConfigError(`unknown variable source \${${kind}:...}; use env, opt, self or file`);
  }

  walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.walk(v)]));
    if (typeof value !== "string" || !value.includes("${")) return value;
    const whole = new RegExp(`^${VAR_SOURCE}$`).exec(value.trim());
    if (whole) {
      const [, kind, a1, a2] = whole;
      try {
        return this.resolveVar(kind, a1 ?? a2);
      } catch (err) {
        if (!(err instanceof MissingVar)) throw err;
        this.unresolved.push(err.message);
        return value;
      }
    }
    return value.replace(new RegExp(VAR_SOURCE, "g"), (match, kind: string, a1?: string, a2?: string) => {
      try {
        const resolved = this.resolveVar(kind, a1 ?? a2 ?? "");
        return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
      } catch (err) {
        if (!(err instanceof MissingVar)) throw err;
        this.unresolved.push(err.message);
        return match;
      }
    });
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function interpolate(data: Obj, opts: Record<string, string>, baseDir: string): Obj {
  let current = data;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const interp = new Interpolator(current, opts, baseDir);
    const next = interp.walk(current) as Obj;
    if (sameJson(next, current)) {
      if (interp.unresolved.length) {
        throw new ConfigError(`unresolved variables: ${[...new Set(interp.unresolved)].sort().join(", ")}`);
      }
      // A value that still holds a resolvable variable after convergence refers to
      // itself (directly or through a cycle such as a -> b -> a).
      const leftover = JSON.stringify(next).match(new RegExp(VAR_SOURCE, "g"));
      if (leftover) {
        throw new ConfigError(`circular variable reference: ${[...new Set(leftover)].sort().join(", ")}`);
      }
      return next;
    }
    current = next;
  }
  throw new ConfigError("variable interpolation did not converge (circular ${self:...} reference?)");
}

export function buildRaw(file: string, options: LoadOptions = {}): Obj {
  const layers = readLayers(path.resolve(file));
  const bases = layers.map((layer) => {
    const { providers: _p, stages: _s, ...rest } = layer;
    return rest;
  });
  let mergedBase: Obj = {};
  for (const base of bases) mergedBase = deepMerge(mergedBase, base) as Obj;
  const name = options.provider ?? (isObj(mergedBase.provider) ? (mergedBase.provider.name as string | undefined) : undefined);
  if (!name) throw new ConfigError("provider.name is required (or pass --provider)");
  const known = [...new Set([...PROVIDERS, ...(options.knownProviders ?? [])])].sort();
  if (!known.includes(name)) throw new ConfigError(`unknown provider '${name}'; supported: ${known.join(", ")}`);

  // Each file's `providers.<name>` override is applied right after that file's own
  // values, so a child file always wins over its parent's per-provider overrides.
  let data: Obj = {};
  let stageOverrides: Obj = {};
  layers.forEach((layer, i) => {
    const overrides = isObj(layer.providers) ? layer.providers : {};
    const unknown = Object.keys(overrides).filter((k) => !known.includes(k));
    if (unknown.length) {
      throw new ConfigError(`\`providers:\` has unknown keys ${unknown.join(", ")}; supported: ${known.join(", ")}`);
    }
    data = deepMerge(data, bases[i]) as Obj;
    data = deepMerge(data, providerOverride(overrides[name])) as Obj;
    stageOverrides = deepMerge(stageOverrides, isObj(layer.stages) ? layer.stages : {}) as Obj;
  });
  const provider: Obj = isObj(data.provider) ? data.provider : {};
  provider.name = name;
  data.provider = provider;

  const effectiveStage = options.stage ?? (provider.stage as string | undefined) ?? "dev";
  data = deepMerge(data, isObj(stageOverrides[effectiveStage]) ? stageOverrides[effectiveStage] : {}) as Obj;
  const finalProvider = data.provider as Obj;
  finalProvider.stage = effectiveStage;
  if (options.region) finalProvider.region = options.region;

  const opts: Record<string, string> = { stage: effectiveStage, provider: name };
  if (finalProvider.region) opts.region = String(finalProvider.region);
  return interpolate(data, opts, path.dirname(path.resolve(file)));
}

export function formatValidationError(err: z.ZodError, file: string): string {
  const lines = [`${path.basename(file)} is invalid:`];
  for (const issue of err.issues) {
    const loc = issue.path.map(String).join(".") || "<root>";
    lines.push(`  - ${loc}: ${issue.message}`);
  }
  return lines.join("\n");
}

/** Parse an already-merged document (used by tests and the programmatic API). */
export function parseConfig(raw: unknown, file = "nskit.yml"): ServiceConfig {
  const result = ServiceConfigSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(formatValidationError(result.error, file));
  return result.data as ServiceConfig;
}

export function loadConfig(file?: string, options: LoadOptions = {}): LoadedConfig {
  const cfgPath = findConfig(file, options.cwd);
  const raw = buildRaw(cfgPath, options);
  const config = parseConfig(raw, cfgPath);
  return { config, path: cfgPath, root: path.dirname(cfgPath), raw };
}
