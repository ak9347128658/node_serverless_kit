/**
 * Order storage behind a tiny interface.
 *
 * On AWS it uses the DynamoDB table that `terraform.extra` creates. Locally
 * (`NSKIT_PROVIDER=local`) it uses a Map, so `nskit dev` needs no credentials.
 * Swapping in Firestore / Cosmos DB for other clouds means adding one class here;
 * the handlers don't change.
 */

import { getEnv } from "node-serverless-kit";

export interface Order {
  id: string;
  item: string;
  status: string;
}

export interface OrderRepository {
  get(id: string): Promise<Order | undefined>;
  put(order: Order): Promise<void>;
}

export class MemoryRepository implements OrderRepository {
  private readonly items = new Map<string, Order>();

  async get(id: string): Promise<Order | undefined> {
    return this.items.get(id);
  }

  async put(order: Order): Promise<void> {
    this.items.set(order.id, { ...order });
  }
}

// The subset of @aws-sdk/client-dynamodb used below (the SDK ships with the Lambda runtime).
interface DynamoSdk {
  DynamoDBClient: new (config: object) => { send(command: unknown): Promise<{ Item?: Record<string, { S?: string }> }> };
  GetItemCommand: new (input: object) => unknown;
  PutItemCommand: new (input: object) => unknown;
}

export class DynamoRepository implements OrderRepository {
  private sdk?: Promise<DynamoSdk>;

  constructor(private readonly tableName: string) {}

  private load(): Promise<DynamoSdk> {
    // A non-literal specifier keeps the SDK out of the bundle and out of local runs:
    // AWS marks @aws-sdk/* as external and the Lambda runtime provides it.
    const name = "@aws-sdk/client-dynamodb";
    this.sdk ??= import(/* @vite-ignore */ name) as Promise<DynamoSdk>;
    return this.sdk;
  }

  async get(id: string): Promise<Order | undefined> {
    const sdk = await this.load();
    const client = new sdk.DynamoDBClient({});
    const { Item } = await client.send(new sdk.GetItemCommand({ TableName: this.tableName, Key: { id: { S: id } } }));
    return Item ? { id: Item.id.S!, item: Item.item.S!, status: Item.status.S! } : undefined;
  }

  async put(order: Order): Promise<void> {
    const sdk = await this.load();
    const client = new sdk.DynamoDBClient({});
    await client.send(
      new sdk.PutItemCommand({
        TableName: this.tableName,
        Item: { id: { S: order.id }, item: { S: order.item }, status: { S: order.status } },
      }),
    );
  }
}

let repo: OrderRepository | undefined;

/** Created once per cold start and reused by warm invocations. */
export function repository(): OrderRepository {
  if (!repo) {
    const table = getEnv("ORDERS_TABLE");
    repo = getEnv("NSKIT_PROVIDER", "local") === "aws" && table ? new DynamoRepository(table) : new MemoryRepository();
  }
  return repo;
}
