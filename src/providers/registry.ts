/**
 * Provider registry.
 *
 * Third-party providers are plain npm packages whose default export (or
 * `provider` export) is a {@link Provider} instance or class. List them in
 * `NSKIT_PROVIDER_PLUGINS` (comma-separated package names, read by the CLI), or call {@link registerProvider}
 * from the programmatic API.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROVIDERS } from "../config/schema.js";
import { AlibabaProvider } from "./alibaba.js";
import { AwsProvider } from "./aws.js";
import { AzureProvider } from "./azure.js";
import { Provider, ProviderError } from "./base.js";
import { CloudflareProvider } from "./cloudflare.js";
import { DigitalOceanProvider } from "./digitalocean.js";
import { GcpProvider } from "./gcp.js";
import { HuaweiProvider } from "./huawei.js";
import { IbmProvider } from "./ibm.js";
import { OracleProvider } from "./oracle.js";
import { TencentProvider } from "./tencent.js";

type ProviderFactory = () => Provider;

const BUILTIN: Record<string, ProviderFactory> = {
  aws: () => new AwsProvider(),
  azure: () => new AzureProvider(),
  gcp: () => new GcpProvider(),
  alibaba: () => new AlibabaProvider(),
  oracle: () => new OracleProvider(),
  ibm: () => new IbmProvider(),
  digitalocean: () => new DigitalOceanProvider(),
  tencent: () => new TencentProvider(),
  huawei: () => new HuaweiProvider(),
  cloudflare: () => new CloudflareProvider(),
};

const plugins = new Map<string, ProviderFactory>();
const cache = new Map<string, Provider>();

/** Register a third-party provider (instance, class or factory). */
export function registerProvider(provider: Provider | (new () => Provider) | ProviderFactory): Provider {
  let instance: Provider;
  if (provider instanceof Provider) instance = provider;
  else if (typeof provider === "function" && provider.prototype instanceof Provider) instance = new (provider as new () => Provider)();
  else instance = (provider as ProviderFactory)();
  plugins.set(instance.name, () => instance);
  cache.delete(instance.name);
  return instance;
}

/**
 * Load provider plug-ins from npm package names (resolved from `cwd`), e.g.
 * `NSKIT_PROVIDER_PLUGINS=nskit-provider-vercel`.
 */
export async function loadProviderPlugins(names: string[], cwd = process.cwd()): Promise<Provider[]> {
  const req = createRequire(path.join(cwd, "noop.js"));
  const loaded: Provider[] = [];
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    let resolved: string;
    try {
      resolved = req.resolve(name);
    } catch {
      throw new ProviderError(`provider plug-in '${name}' is not installed (npm install ${name})`);
    }
    const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    const candidate = mod.provider ?? mod.default ?? (mod as { default?: { default?: unknown } }).default?.default;
    if (!candidate) throw new ProviderError(`provider plug-in '${name}' has no default or 'provider' export`);
    loaded.push(registerProvider(candidate as Provider));
  }
  return loaded;
}

export function available(): string[] {
  return [...new Set([...PROVIDERS, ...plugins.keys()])].sort();
}

export function getProvider(name: string): Provider {
  const cached = cache.get(name);
  if (cached) return cached;
  const factory = plugins.get(name) ?? BUILTIN[name];
  if (!factory) throw new ProviderError(`unknown provider '${name}'; available: ${available().join(", ")}`);
  const provider = factory();
  cache.set(name, provider);
  return provider;
}

export function allProviders(): Provider[] {
  return available().map(getProvider);
}
