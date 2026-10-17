export function parseRedisUrl(value: string): {
  host: string;
  port: number;
  password: string;
  db: number;
  tls: boolean;
};
export function encodeCommand(args: readonly unknown[]): string;
export function createParser(): { push(chunk: Uint8Array): unknown[] };
export function createRedisBroker(url: string): Promise<{ close(): void }>;
