/** Partial batch failure reporting for queue / topic / storage events. */

import { EventRecord } from "./event.js";

/** Thrown on providers without partial-batch support so the whole batch is redelivered. */
export class BatchFailure extends Error {
  readonly failedIds: string[];

  constructor(failedIds: string[]) {
    super(`${failedIds.length} record(s) failed: ${failedIds.slice(0, 10).join(", ")}`);
    this.name = "BatchFailure";
    this.failedIds = failedIds;
  }
}

const BATCH_RESULT = Symbol.for("node_serverless_kit.BatchResult");

/**
 * Return this from a batch handler to retry only the records that failed.
 *
 * On AWS SQS it becomes `batchItemFailures`; on every other provider any
 * failure makes the whole invocation fail (and therefore retry).
 */
export class BatchResult {
  readonly failed: string[] = [];
  readonly [BATCH_RESULT] = true;

  fail(record: EventRecord | string): this {
    const id = typeof record === "string" ? record : record.id;
    if (id !== undefined && id !== null) this.failed.push(id);
    return this;
  }

  static of(failed: Iterable<EventRecord | string>): BatchResult {
    const result = new BatchResult();
    for (const item of failed) result.fail(item);
    return result;
  }

  get ok(): boolean {
    return this.failed.length === 0;
  }

  throwIfFailed(): void {
    if (this.failed.length) throw new BatchFailure(this.failed);
  }

  toJSON(): { failed: string[] } {
    return { failed: [...this.failed] };
  }
}

export function isBatchResult(value: unknown): value is BatchResult {
  return value instanceof BatchResult || (typeof value === "object" && value !== null && BATCH_RESULT in value);
}

/**
 * Process every record with `fn` (concurrently up to `concurrency`), collecting
 * failures into a {@link BatchResult}. A convenience for the common worker loop.
 */
export async function processBatch(
  records: Iterable<EventRecord>,
  fn: (record: EventRecord) => unknown,
  options: { concurrency?: number; onError?: (record: EventRecord, error: unknown) => void } = {},
): Promise<BatchResult> {
  const list = [...records];
  const result = new BatchResult();
  const limit = Math.max(1, options.concurrency ?? 1);
  let next = 0;
  const failed = new Set<number>();
  async function worker(): Promise<void> {
    while (next < list.length) {
      const index = next++;
      try {
        await fn(list[index]);
      } catch (err) {
        failed.add(index);
        options.onError?.(list[index], err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  // Keep the original record order in the result.
  list.forEach((record, i) => failed.has(i) && result.fail(record));
  return result;
}
