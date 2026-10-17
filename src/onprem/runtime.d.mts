export const MIN_NODE_MAJOR: number;
export const MESSAGES: Record<string, string>;
export const LAUNCH_KEYS: string[];

export function nodeMajor(version: string | undefined): number;

export interface RuntimeFacts {
  runtime?: string;
  bundledExecutable?: string;
  bundledRuns?: boolean;
  bundledVersion?: string;
  systemNode?: string;
  systemVersion?: string;
  dockerOk?: boolean;
}

export interface RuntimeChoice {
  mode: "bundled" | "system" | "docker" | "none";
  bin: string;
  message: string;
}

export function chooseRuntime(facts: RuntimeFacts): RuntimeChoice;
export function expandHome(value: string): string;
export function resolveNodeBinary(input: string): string;
export function bundledNodeName(binaryPath: string, targetOs: string): string;
export function launchEnv(vars: Record<string, string | undefined>): string;
export function shellQuote(value: string): string;
export function psQuote(value: string): string;
export function sshTarget(env: Record<string, string | undefined>): string;
export function sshArgs(env: Record<string, string | undefined>): string[];
export function prepareCommand(env: Record<string, string | undefined>): string;
export function extractCommand(absPath: string): string;
export function startCommand(env: Record<string, string | undefined>, absPath: string): string;
export function stopCommand(env: Record<string, string | undefined>, absPath: string): string;
export function startNote(vars: Record<string, string | undefined>): string;
