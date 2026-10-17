export function fieldMatches(field: string, value: number, min: number, max: number, names?: Record<string, number>): boolean;
export function cronMatches(expression: string, date: Date, timeZone?: string): boolean;
export function startPlatform(options?: {
  platform?: unknown;
  workers?: boolean;
  entry?: string;
  host?: string;
  port?: number;
  platformFile?: string;
}): Promise<{
  url: string;
  port: number;
  broker: { enqueue(name: string, body?: unknown, attributes?: Record<string, unknown>): string };
  fireSchedule(spec: { function: string; input?: unknown; name?: string }): Promise<unknown>;
  close(): Promise<void>;
}>;
