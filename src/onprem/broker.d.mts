interface BrokerMessage {
  id: string;
  body: unknown;
  receiveCount?: number;
}

interface TopicPull {
  events: Array<{ body: { id: string } }>;
}

interface StoragePull {
  events: Array<{ key: string; action: string }>;
}

export interface Broker {
  enqueue(name: string, body?: unknown, attributes?: Record<string, unknown>): string;
  receive(name: string, options?: Record<string, unknown>): Promise<BrokerMessage[]>;
  ack(name: string, ids: string[]): number;
  nack(name: string, ids: string[], options?: Record<string, unknown>): number;
  publish(name: string, body?: unknown, attributes?: Record<string, unknown>): unknown;
  pullTopic(name: string, options?: Record<string, unknown>): Promise<TopicPull>;
  putObject(bucket: string, key: string, bytes: Uint8Array): unknown;
  getObject(bucket: string, key: string): Buffer;
  pullStorage(bucket: string, options?: Record<string, unknown>): Promise<StoragePull>;
  close(): void;
}

export interface HttpBroker {
  enqueue(name: string, body?: unknown, attributes?: Record<string, unknown>): Promise<unknown>;
  receive(name: string, options?: Record<string, unknown>): Promise<BrokerMessage[]>;
  ack(name: string, ids: string[]): Promise<number>;
  publish(name: string, body?: unknown, attributes?: Record<string, unknown>): Promise<unknown>;
  pullTopic(name: string, options?: Record<string, unknown>): Promise<TopicPull>;
  putObject(bucket: string, key: string, bytes: Uint8Array): Promise<unknown>;
  pullStorage(bucket: string, options?: Record<string, unknown>): Promise<StoragePull>;
}

export function createBroker(options?: { dataDir?: string }): Broker;
export function createHttpBroker(baseUrl: string): HttpBroker;
export function listenBroker(
  broker: Broker,
  port?: number,
  host?: string,
): Promise<{ url: string; port: number; close(): Promise<void> }>;
export function matchFilter(filter: unknown, attributes: unknown): boolean;
export function matchObject(spec: unknown, key: string): boolean;
export function handleBrokerRequest(broker: Broker, req: unknown, res: unknown): Promise<boolean>;
