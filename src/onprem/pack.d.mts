export const PLATFORM_FILES: string[];

export function stagePayload(spec: {
  dest: string;
  appDir: string;
  platformDir: string;
  nodeBinary?: string;
  targetOs?: string;
  envVars: Record<string, string | undefined>;
}): string;

export function varsFromEnv(env: Record<string, string | undefined>): Record<string, string>;
