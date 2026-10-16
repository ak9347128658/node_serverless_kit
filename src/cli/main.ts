/** `nskit` command line interface. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";
import pc from "picocolors";
import { stringify as toYaml } from "yaml";
import { ConfigError } from "../config/loader.js";
import { PROVIDERS, eventsOf } from "../config/schema.js";
import { Deployer, DeployError } from "../core/deployer.js";
import { Project } from "../core/project.js";
import { collectRecords, localRecord, serveDashboard, writeDashboard, type DashboardRecord } from "../dashboard/generator.js";
import { LocalRunner } from "../local/runner.js";
import { invokeEvent, isWorkflowFailed, loadDotenv, routeTable, startDevServer, toPlain, UnknownTargetError, decodeBody } from "../local/server.js";
import { BuildError } from "../packaging/builder.js";
import { ProviderError } from "../providers/base.js";
import { available, getProvider, loadProviderPlugins } from "../providers/registry.js";
import { ScheduleError } from "../providers/schedule.js";
import { TerraformError, TerraformRunner } from "../terraform/runner.js";
import { VERSION } from "../version.js";
import { compileAsl } from "../workflows/asl.js";
import { definitionData } from "../workflows/index.js";
import { defaultIO, type CliIO, type Colors } from "./io.js";
import { LANGUAGES, render as renderTemplate, TEMPLATES, type Language, type TemplateName } from "./templates.js";

export type { CliIO } from "./io.js";

/** A user-facing failure with an exit code (printed as `Error: <message>`). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Ends the command with an exit code without printing anything more. */
class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
  }
}

const KNOWN_ERRORS = [ConfigError, DeployError, BuildError, ProviderError, ScheduleError, TerraformError, CliError, UnknownTargetError];

function isKnownError(err: unknown): err is Error {
  return KNOWN_ERRORS.some((cls) => err instanceof cls);
}

interface ProjectOpts {
  config?: string;
  provider?: string;
  stage?: string;
  region?: string;
  verbose?: boolean;
}

const EXAMPLES = `
Examples:
  $ nskit init my-api -p aws -t full      scaffold a project
  $ nskit dev                             local server with hot reload
  $ nskit invoke -f hello --path "/hello?name=Ada"
  $ nskit validate -p gcp                 check the config for another cloud
  $ nskit deploy --stage prod             bundle + terraform apply
  $ nskit info                            endpoints and resource ids
  $ nskit dashboard --open                every deployment on one page
  $ nskit remove -y                       terraform destroy

Docs: https://github.com/ak9347128658/node_serverless_kit/tree/main/docs`;

/** Strip `node script` from `process.argv`; plain argument lists are used as is. */
function userArgs(argv: string[]): string[] {
  if (argv.length >= 2 && /(^|[\\/])(node|nodejs|bun|deno)(\.exe)?$/i.test(argv[0])) return argv.slice(2);
  return argv;
}

function parseIntOption(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliError(`invalid port '${value}'`);
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `{"a":1}` -> object, `@file.json` -> file content (JSON when it parses), anything else -> the string. */
export function parseData(raw: string | undefined, cwd = process.cwd()): unknown {
  if (raw === undefined) return undefined;
  let text = raw;
  if (raw.startsWith("@")) {
    const file = path.resolve(cwd, raw.slice(1));
    if (!existsSync(file)) throw new CliError(`data file not found: ${file}`);
    text = readFileSync(file, "utf-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/** Run `fn` with console.log/info/debug redirected to stderr, so stdout carries only the result. */
async function logsToStderr<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const toErr = (...args: unknown[]) => console.error(...args);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

// ------------------------------------------------------------------ output helpers

function printRecord(io: CliIO, c: Colors, record: DashboardRecord): void {
  if (record.endpoint) io.out(`endpoint: ${c.underline(String(record.endpoint))}`);
  io.out(c.bold("functions:"));
  for (const f of record.functions ?? []) {
    const triggers = (f.events ?? []).map((e) => e.summary).join(", ") || "direct invoke";
    io.out(`  ${f.name.padEnd(24)} ${String(f.kind).padEnd(13)} ${c.dim(triggers)}`);
    for (const u of f.urls ?? []) io.out(`      ${u.method.padEnd(6)} ${u.url}`);
    if (f.url && !(f.urls ?? []).length) io.out(`      url: ${f.url}`);
    if (f.arn || f.id) io.out(c.dim(`      id:  ${f.arn || f.id}`));
  }
  if ((record.workflows ?? []).length) {
    io.out(c.bold("workflows:"));
    for (const w of record.workflows ?? []) {
      io.out(`  ${w.name.padEnd(24)} ${String(w.engine).padEnd(9)} ${w.id ?? ""}`.trimEnd());
    }
  }
}

function table(rows: string[][], indent = "  "): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => indent + r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ").trimEnd());
}

// ------------------------------------------------------------------ the program

export function buildProgram(io: CliIO): Command {
  const c = pc.createColors(io.color);
  const program = new Command("nskit");

  program
    .description("node-serverless-kit: write Node.js functions once, deploy them to any cloud with Terraform.")
    .version(VERSION, "-V, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .showSuggestionAfterError(true)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, "")),
      writeErr: (s) => io.err(s.replace(/\n$/, "")),
      outputError: (s, write) => write(c.red(s)),
    })
    .addHelpText("after", EXAMPLES);

  const withProjectOptions = (cmd: Command): Command =>
    cmd
      .option("-c, --config <file>", "config file (default: nskit.yml)")
      .option("-p, --provider <name>", `override provider.name (${PROVIDERS.join(", ")}, or a plug-in)`)
      .option("-s, --stage <stage>", "stage, e.g. dev / staging / prod")
      .option("-r, --region <region>", "override provider.region")
      .option("-v, --verbose", "print stack traces on errors");

  const load = (opts: ProjectOpts): Project =>
    Project.load(opts.config, { provider: opts.provider, stage: opts.stage, region: opts.region });

  const deployer = (project: Project): Deployer => {
    const echo = (m: string) => io.out(m);
    return new Deployer(project, echo, io.terraformRunner?.(project, echo));
  };

  const loadRunner = async (project: Project, opts: ProjectOpts, extra: { env?: Record<string, string>; sleep?: boolean } = {}) =>
    LocalRunner.fromConfig(project.loaded.path, {
      provider: opts.provider,
      stage: opts.stage,
      region: opts.region,
      mode: "bundle",
      env: extra.env,
      sleep: extra.sleep ? (s) => new Promise((resolve) => setTimeout(resolve, s * 1000)) : undefined,
    });

  const envFileOf = (project: Project, file: string | undefined): string | undefined =>
    file ? (path.isAbsolute(file) ? file : existsSync(path.resolve(file)) ? path.resolve(file) : path.resolve(project.root, file)) : undefined;

  // ---------------------------------------------------------------- init
  program
    .command("init")
    .description("scaffold a new project")
    .argument("[dir]", "target directory", ".")
    .option("--name <service>", "service name (default: the directory name)")
    .addOption(new Option("-p, --provider <name>", "target cloud").choices([...PROVIDERS]).default("aws"))
    .addOption(new Option("-t, --template <template>", "project template").choices([...TEMPLATES]).default("http"))
    .addOption(new Option("--lang <lang>", "handler language").choices([...LANGUAGES]).default("ts"))
    .option("--force", "overwrite existing files")
    .action((dir: string, opts: { name?: string; provider: string; template: TemplateName; lang: Language; force?: boolean }) => {
      const target = path.resolve(dir);
      const service =
        opts.name ??
        (path
          .basename(target)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^[^a-z]+|-+$/g, "")
          .slice(0, 32) ||
          "my-service");
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(service)) {
        throw new CliError(`invalid service name '${service}': use 2-32 lowercase letters, digits and dashes (--name)`);
      }
      const files = renderTemplate({
        template: opts.template,
        service,
        provider: opts.provider,
        lang: opts.lang,
        capabilities: getProvider(opts.provider).capabilities,
      });
      mkdirSync(target, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const file = path.join(target, rel);
        if (existsSync(file) && !opts.force) {
          io.out(`  ${c.yellow("skip")}   ${rel} (exists; --force overwrites)`);
          continue;
        }
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content, "utf-8");
        io.out(`  ${c.green("create")} ${rel}`);
      }
      io.out("");
      io.out(c.green(`Created service '${service}' (${opts.template}, ${opts.lang}) for ${opts.provider} in ${target}`));
      io.out("Next steps:");
      if (path.resolve(dir) !== process.cwd()) io.out(`  cd ${dir}`);
      io.out("  npm install");
      io.out("  npx nskit dev          # local server with hot reload");
      io.out("  npm test               # vitest + LocalRunner");
      io.out("  npx nskit deploy       # deploy with terraform");
    });

  // ---------------------------------------------------------------- validate
  withProjectOptions(program.command("validate").description("validate the config against the selected provider")).action(
    (opts: ProjectOpts) => {
      const project = load(opts);
      const issues = project.validate();
      const cfg = project.config;
      io.out(
        c.cyan(
          `${cfg.service} -> ${project.provider.displayName} [${project.provider.tier}] stage=${cfg.provider.stage} ` +
            `region=${project.region || "-"} runtime=${cfg.provider.runtime}`,
        ),
      );
      const fnCount = Object.keys(cfg.functions).length;
      const wfCount = Object.keys(cfg.workflows).length;
      io.out(`  ${fnCount} function(s), ${wfCount} workflow(s)`);
      if (fnCount) {
        const rows = [["function", "kind", "triggers"]];
        for (const [name, fn] of Object.entries(cfg.functions).sort(([a], [b]) => a.localeCompare(b))) {
          const triggers = fn.events.map((e) => {
            const cfgEv = e.config as unknown as Record<string, unknown>;
            switch (e.type) {
              case "http":
                return `${cfgEv.method} ${cfgEv.path}`;
              case "schedule":
                return cfgEv.rate ? `rate(${cfgEv.rate})` : `cron(${cfgEv.cron})`;
              case "storage":
                return `storage ${cfgEv.bucket}`;
              default:
                return `${e.type} ${cfgEv.name}`;
            }
          });
          rows.push([name, kindOf(fn.events.map((e) => e.type)), triggers.join(", ") || "direct invoke"]);
        }
        const lines = table(rows);
        io.out(c.dim(lines[0]));
        for (const line of lines.slice(1)) io.out(line);
      }
      for (const [name, engine] of Object.entries(project.engines)) io.out(`  workflow ${name}: ${engine} engine`);
      for (const issue of issues) {
        if (issue.level === "error") io.err(c.red(`  ${issue}`));
        else io.out(c.yellow(`  ${issue}`));
      }
      const errors = issues.filter((i) => i.level === "error").length;
      if (errors) {
        io.err(c.red(`${errors} error(s) found.`));
        throw new CliExit(1);
      }
      io.out(c.green("Configuration is valid."));
    },
  );

  // ---------------------------------------------------------------- package / plan / deploy / remove
  withProjectOptions(program.command("package").description("bundle the code and generate Terraform (no cloud calls)"))
    .option("--skip-install", "do not npm-install external dependencies into the artifact")
    .action(async (opts: ProjectOpts & { skipInstall?: boolean }) => {
      const project = load(opts);
      const result = await deployer(project).package({ skipInstall: opts.skipInstall });
      io.out(
        c.green(
          `Packaged into ${path.relative(process.cwd(), project.workDir) || "."} ` +
            `(${result.resourceCount} terraform resources, artifact ${(result.artifact.size / 1024).toFixed(1)} KiB)`,
        ),
      );
    });

  withProjectOptions(program.command("plan").description("package, then show the terraform plan"))
    .option("--skip-install", "do not npm-install external dependencies into the artifact")
    .option("--destroy", "plan a destroy instead")
    .action(async (opts: ProjectOpts & { skipInstall?: boolean; destroy?: boolean }) => {
      const project = load(opts);
      const changed = await deployer(project).plan({ skipInstall: opts.skipInstall, destroy: opts.destroy });
      io.out(changed ? c.yellow("Plan has changes.") : c.green("No changes."));
    });

  withProjectOptions(program.command("deploy").description("package and deploy with terraform apply"))
    .option("--skip-install", "do not npm-install external dependencies into the artifact")
    .option("--confirm", "run terraform plan, then apply that plan (instead of -auto-approve)")
    .option("--upgrade", "terraform init -upgrade (update provider plugins)")
    .option("--no-dashboard", "do not regenerate the dashboard")
    .action(async (opts: ProjectOpts & { skipInstall?: boolean; confirm?: boolean; upgrade?: boolean; dashboard: boolean }) => {
      const project = load(opts);
      const record = await deployer(project).deploy({ skipInstall: opts.skipInstall, autoApprove: !opts.confirm, upgrade: opts.upgrade });
      io.out("");
      io.out(c.green(`Deployed ${record.service} (${record.stage}) to ${record.providerDisplay} ${record.region}`));
      printRecord(io, c, record);
      if (opts.dashboard) {
        const file = writeDashboard(project.root);
        io.out(`\nDashboard: ${pathToFileURL(file).href}`);
      }
    });

  withProjectOptions(program.command("remove").description("destroy every resource of this service / stage"))
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (opts: ProjectOpts & { yes?: boolean }) => {
      const project = load(opts);
      const cfg = project.config;
      if (!opts.yes) {
        const question = `Destroy ALL resources of '${cfg.service}' stage '${cfg.provider.stage}' on ${project.provider.displayName}?`;
        if (!io.isTTY) throw new CliError("refusing to remove without confirmation in a non-interactive shell; pass -y / --yes");
        if (!(await io.confirm(question))) {
          io.err("Aborted.");
          throw new CliExit(1);
        }
      }
      await deployer(project).remove({ autoApprove: true });
      writeDashboard(project.root);
      io.out(c.green("Removed."));
    });

  // ---------------------------------------------------------------- info / dashboard
  withProjectOptions(program.command("info").description("show what is deployed (functions, URLs, ids)"))
    .option("--json", "machine readable output")
    .option("--refresh", "re-read terraform outputs instead of the saved record")
    .action((opts: ProjectOpts & { json?: boolean; refresh?: boolean }) => {
      const project = load(opts);
      const d = deployer(project);
      let record: DashboardRecord | undefined = opts.refresh ? d.refreshInfo() : d.loadRecord();
      if (!record) record = localRecord(project, "not deployed");
      if (opts.json) {
        io.out(json(record));
        return;
      }
      const status = String(record.status);
      const colored = status === "deployed" ? c.green(status) : status === "removed" ? c.dim(status) : c.yellow(status);
      io.out(c.cyan(`${record.service} | ${record.stage} | ${record.providerDisplay} | ${record.region || "-"} | `) + colored);
      if (record.deployedAt && status !== "not deployed") io.out(c.dim(`updated ${record.deployedAt}`));
      printRecord(io, c, record);
    });

  program
    .command("dashboard")
    .description("generate (and optionally serve) the deployment dashboard")
    .argument("[dir]", "project root containing .nskit/", ".")
    .option("-o, --output <file>", "write the HTML here (default: .nskit/dashboard/index.html)")
    .option("--serve", "serve the dashboard over HTTP on 127.0.0.1")
    .option("--port <port>", "port for --serve", parseIntOption, 8765)
    .option("--open", "open it in the browser")
    .action(async (dir: string, opts: { output?: string; serve?: boolean; port: number; open?: boolean }) => {
      const root = path.resolve(dir);
      if (!existsSync(root)) throw new CliError(`directory not found: ${root}`);
      let records = collectRecords(root);
      if (!records.length) {
        try {
          records = [localRecord(Project.load(undefined, { cwd: root }))];
          io.out("No deployments yet - showing the configured (local) view.");
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
        }
      }
      const file = writeDashboard(root, { records, output: opts.output });
      io.out(c.green(`Dashboard written to ${file}`) + c.dim(` (${records.length} deployment(s))`));
      if (opts.serve) {
        const { server, url } = await serveDashboard(file, { port: opts.port });
        io.out(`Serving on ${c.underline(url)} (Ctrl+C to stop)`);
        if (opts.open) io.openUrl(url);
        await io.waitForShutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } else if (opts.open) {
        io.openUrl(pathToFileURL(file).href);
      }
    });

  // ---------------------------------------------------------------- local
  withProjectOptions(program.command("dev").description("local HTTP server that routes to your handlers (hot reload)"))
    .option("--host <host>", "interface to bind", "127.0.0.1")
    .option("--port <port>", "port", parseIntOption, 3000)
    .option("--env-file <file>", "dotenv file loaded into the environment", ".env")
    .option("--no-watch", "do not reload on source changes")
    .action(async (opts: ProjectOpts & { host: string; port: number; envFile: string; watch: boolean }) => {
      const project = load(opts);
      const envFile = envFileOf(project, opts.envFile);
      io.out(c.dim(`Bundling ${project.config.service}...`));
      const runner = await loadRunner(project, opts, { env: envFile ? loadDotenv(envFile) : {} });
      const dev = await startDevServer(runner, {
        host: opts.host,
        port: opts.port,
        watch: opts.watch,
        envFile,
        log: (m) => io.out(m),
      });
      io.out(c.green(`nskit dev server for '${project.config.service}' on ${dev.url}`));
      for (const line of routeTable(runner, dev.url)) io.out(line);
      if (opts.watch) io.out(c.dim(`Watching ${project.sourceDir} for changes.`));
      io.out(c.dim("Press Ctrl+C to stop."));
      await io.waitForShutdown();
      io.out("stopping");
      await dev.close();
    });

  withProjectOptions(program.command("invoke").description("invoke a function locally with a synthetic event"))
    .requiredOption("-f, --function <name>", "function name from the config")
    .addOption(
      new Option("-e, --event <type>", "event type (default: http if the function has http events, else invoke)").choices([
        "http",
        "invoke",
        "schedule",
        "queue",
        "topic",
        "storage",
      ]),
    )
    .option("-d, --data <json>", "payload: JSON, @file.json, or plain text")
    .option("--method <method>", "HTTP method (default: the route's method, or GET)")
    .option("--path <path>", "HTTP path incl. query string (default: the route's path)")
    .option("-H, --header <header>", "HTTP header 'Name: value' (repeatable)", collect, [])
    .option("--env-file <file>", "dotenv file loaded into the environment", ".env")
    .action(
      async (
        opts: ProjectOpts & { function: string; event?: string; data?: string; method?: string; path?: string; header: string[]; envFile: string },
      ) => {
        const project = load(opts);
        const fn = project.config.functions[opts.function];
        if (!fn) {
          throw new CliError(`unknown function '${opts.function}'; known: ${Object.keys(project.config.functions).sort().join(", ")}`);
        }
        const routes = eventsOf(fn, "http");
        const kind = opts.event ?? (routes.length ? "http" : "invoke");
        const headers: Record<string, string> = {};
        for (const raw of opts.header) {
          const idx = raw.indexOf(":");
          if (idx <= 0) throw new CliError(`expected --header 'Name: value', got '${raw}'`);
          headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
        }
        const data = parseData(opts.data);
        const envFile = envFileOf(project, opts.envFile);
        const runner = await loadRunner(project, opts, { env: envFile ? loadDotenv(envFile) : {} });
        let output: unknown;
        try {
          output = await logsToStderr(async () => {
            if (kind !== "http") return toPlain(runner, await invokeEvent(runner, opts.function, kind, data));
            const route = routes[0];
            const method = (opts.method ?? (route && route.method !== "ANY" ? route.method : "GET")).toUpperCase();
            const urlPath = opts.path ?? route?.path ?? "/";
            const call =
              data === undefined ? {} : typeof data === "string" ? { body: data } : { json: data };
            const resp = await runner.http(method, urlPath, { headers, ...call });
            if (resp.functionName && resp.functionName !== opts.function) {
              io.err(c.yellow(`note: ${method} ${urlPath} is routed to '${resp.functionName}', not '${opts.function}'`));
            }
            return { status: resp.status, headers: resp.headers, body: decodeBody(resp.headers["content-type"], resp.body) };
          });
        } catch (err) {
          if (err instanceof UnknownTargetError) throw err;
          const e = err as Error;
          if (e?.stack) io.err(c.dim(e.stack));
          io.err(c.red(`${opts.function} raised ${e?.name ?? "Error"}: ${e?.message ?? String(err)}`));
          throw new CliExit(1);
        }
        io.out(json(output));
      },
    );

  // ---------------------------------------------------------------- workflows
  const workflow = program.command("workflow").description("run or inspect workflows (state machines)");

  withProjectOptions(workflow.command("run").description("run a workflow locally on the embedded engine"))
    .argument("<name>", "workflow name")
    .option("-i, --input <json>", "input: JSON or @file.json")
    .option("--sleep", "honour wait states (default: skip waiting)")
    .option("--history", "print the execution history")
    .action(async (name: string, opts: ProjectOpts & { input?: string; sleep?: boolean; history?: boolean }) => {
      const project = load(opts);
      if (!(name in project.config.workflows)) {
        throw new CliError(`unknown workflow '${name}'; known: ${Object.keys(project.config.workflows).sort().join(", ") || "(none)"}`);
      }
      const input = parseData(opts.input);
      const runner = await loadRunner(project, opts, { sleep: opts.sleep });
      try {
        const result = await logsToStderr(() => runner.workflow(name, input ?? null));
        io.out(c.green("SUCCEEDED"));
        io.out(json(result.output));
        if (opts.history) io.out(json(result.history));
      } catch (err) {
        if (!isWorkflowFailed(err)) throw err;
        io.err(c.red(`FAILED ${err.error}: ${err.cause}`));
        if (opts.history) io.out(json(err.history));
        throw new CliExit(2);
      }
    });

  withProjectOptions(workflow.command("show").description("print the compiled workflow definition"))
    .argument("<name>", "workflow name")
    .addOption(new Option("--format <format>", "output format").choices(["auto", "asl", "gcp", "json"]).default("auto"))
    .action(async (name: string, opts: ProjectOpts & { format: string }) => {
      const project = load(opts);
      const wf = project.config.workflows[name];
      if (!wf) throw new CliError(`unknown workflow '${name}'; known: ${Object.keys(project.config.workflows).sort().join(", ") || "(none)"}`);
      const definition = definitionData(wf);
      let format = opts.format;
      if (format === "auto") format = ({ aws: "asl", gcp: "gcp" } as Record<string, string>)[project.config.provider.name] ?? "json";
      let out: unknown = definition;
      if (format === "asl") {
        out = compileAsl(definition, (f) => `<arn of ${f}>`, wf.description, wf.timeout ?? 0);
      } else if (format === "gcp") {
        const compiled = await compileGcpWorkflow(definition, name);
        if (compiled) {
          out = compiled.definition;
          for (const w of compiled.warnings) io.err(c.yellow(`warning: ${w}`));
        } else {
          io.err(c.yellow("warning: the Cloud Workflows compiler is not available in this build; printing the portable definition"));
        }
      }
      io.out(json(out));
    });

  // ---------------------------------------------------------------- providers / print / tf
  program
    .command("providers")
    .description("list supported clouds and what each supports")
    .option("--json", "machine readable output")
    .action((opts: { json?: boolean }) => {
      const rows: Record<string, unknown>[] = [];
      for (const name of available()) {
        try {
          rows.push(getProvider(name).describe());
        } catch (err) {
          rows.push({ name, tier: "unavailable", error: (err as Error).message });
        }
      }
      if (opts.json) {
        io.out(json(rows));
        return;
      }
      const cols = ["http", "schedule", "queue", "storage", "topic", "workflow_native"];
      const header = ["provider", "tier", "region", ...cols.map((x) => (x === "workflow_native" ? "workflows" : x))];
      const body = rows.map((r) => {
        const caps = new Set((r.capabilities as string[] | undefined) ?? []);
        return [
          String(r.name),
          String(r.tier ?? ""),
          String(r.defaultRegion || "-"),
          ...cols.map((x) => (x === "workflow_native" ? (caps.has(x) ? "native" : "embedded") : caps.has(x) ? "yes" : "-")),
        ];
      });
      const lines = table([header, ...body], "");
      io.out(c.bold(lines[0]));
      for (const line of lines.slice(1)) {
        io.out(line.replace(/\byes\b/g, c.green("yes")).replace(/\bexperimental\b/, c.yellow("experimental")));
      }
    });

  withProjectOptions(program.command("print").description("print the resolved, interpolated config"))
    .option("--json", "print JSON")
    .option("--yaml", "print YAML (default)")
    .action((opts: ProjectOpts & { json?: boolean; yaml?: boolean }) => {
      const project = load(opts);
      const cfg = project.loaded.config;
      const resolved = { ...cfg, provider: { ...cfg.provider, runtime: project.config.provider.runtime, region: project.region || null } };
      io.out(opts.json && !opts.yaml ? json(resolved) : toYaml(resolved, { lineWidth: 0 }).trimEnd());
    });

  withProjectOptions(
    program
      .command("tf")
      .description("run any terraform command in the generated workspace, e.g. `nskit tf -- state list`")
      .argument("[args...]", "terraform arguments")
      .allowUnknownOption()
      .passThroughOptions(),
  ).action((args: string[], opts: ProjectOpts) => {
    const project = load(opts);
    if (!existsSync(path.join(project.workDir, "main.tf.json"))) {
      throw new CliError("nothing generated yet; run `nskit package` first");
    }
    if (!args.length) throw new CliError("pass terraform arguments, e.g. `nskit tf -- state list`");
    const echo = (m: string) => io.out(m);
    const runner =
      io.terraformRunner?.(project, echo) ?? new TerraformRunner(project.workDir, { binary: project.config.provider.terraform.binary, echo });
    const code = runner.passthrough(args);
    if (code !== 0) throw new CliExit(code);
  });

  return program;
}

function kindOf(types: string[]): string {
  const set = new Set(types);
  if (!set.size) return "invoke-only";
  if (set.size === 1 && set.has("http")) return "http";
  if (set.size === 1 && set.has("schedule")) return "scheduled";
  if (set.has("http")) return "http+event";
  return "event-driven";
}

/**
 * Compile with `src/workflows/gcp.ts` when this build has it. Loaded lazily
 * (the module may not exist yet); returns `undefined` when unavailable.
 */
async function compileGcpWorkflow(
  definition: ReturnType<typeof definitionData>,
  name: string,
): Promise<{ definition: unknown; warnings: string[] } | undefined> {
  const moduleName = "gcp";
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`../workflows/${moduleName}.ts`)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const compile = (mod.compileGcp ?? mod.compileGcpWorkflow ?? mod.compileWorkflow ?? mod.default) as
    | ((def: unknown, urlOf: (f: string) => string, name: string) => unknown)
    | undefined;
  if (typeof compile !== "function") return undefined;
  const result = compile(definition, (f) => `<url of ${f}>`, name);
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[1])) {
    return { definition: result[0], warnings: result[1].map(String) };
  }
  if (result && typeof result === "object" && "warnings" in result && Array.isArray((result as { warnings: unknown }).warnings)) {
    const r = result as { warnings: unknown[]; definition?: unknown; workflow?: unknown; source?: unknown };
    return { definition: r.definition ?? r.workflow ?? r.source ?? result, warnings: r.warnings.map(String) };
  }
  return { definition: result, warnings: [] };
}

/** Run the CLI and return the exit code (never exits the process). */
export async function run(argv: string[], io: CliIO): Promise<number> {
  process.env.NSKIT_LOG_FORMAT ??= "text";
  const args = userArgs(argv);
  const verbose = args.includes("-v") || args.includes("--verbose");
  const c = pc.createColors(io.color);
  const program = buildProgram(io);
  try {
    if (!args.length) {
      program.outputHelp();
      return 0;
    }
    // Third-party providers: NSKIT_PROVIDER_PLUGINS=pkg-a,pkg-b (resolved from the cwd).
    const plugins = (process.env.NSKIT_PROVIDER_PLUGINS ?? "").split(",").filter((n) => n.trim());
    if (plugins.length) await loadProviderPlugins(plugins);
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CliExit) return err.exitCode;
    if (err instanceof CommanderError) return err.exitCode;
    const e = err as Error;
    if (verbose && e?.stack) io.err(c.dim(e.stack));
    if (isKnownError(err)) {
      io.err(c.red(`Error: ${e.message}`));
      return err instanceof CliError ? err.exitCode : 1;
    }
    io.err(c.red(`Error: ${e?.message ?? String(err)}`));
    if (!verbose) io.err(c.dim("(run with -v for the stack trace)"));
    return 1;
  }
}

/**
 * Entry point used by `bin/nskit.js` (`main(process.argv)`). Tests may pass
 * plain arguments plus an {@link CliIO} override to capture output and the
 * exit code instead of exiting the process.
 */
export async function main(argv: string[], io: Partial<CliIO> = {}): Promise<void> {
  const resolved: CliIO = { ...defaultIO(), ...io };
  const code = await run(argv, resolved);
  resolved.exit(code);
}
