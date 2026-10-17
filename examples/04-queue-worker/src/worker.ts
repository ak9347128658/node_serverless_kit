/**
 * Queue consumer with partial batch failure reporting.
 *
 * `event.records` holds the messages of one batch. Return a `BatchResult` naming
 * the records that failed:
 *
 * - AWS SQS:      only those messages become visible again and are retried
 *                 (`ReportBatchItemFailures` is enabled for you);
 * - other clouds: any failure fails the invocation, so the whole batch is redelivered.
 *
 * Either way a message that keeps failing ends up in the dead-letter queue configured
 * in nskit.yml (where the cloud supports one) instead of blocking the queue forever.
 */

import { BadRequest, defineHandler, HttpResponse, processBatch, type Context, type EventRecord } from "node_serverless_kit";

const SUPPORTED_KINDS = new Set(["email", "thumbnail", "invoice"]);

interface Job {
  id?: string;
  kind?: string;
  simulateFailure?: boolean;
}

/** Retrying will not help (bad payload): log it and drop the message. */
export class PermanentError extends Error {
  override name = "PermanentError";
}

export async function handleJob(job: Job): Promise<{ kind: string; id?: string; status: "done" }> {
  if (!job.kind || !SUPPORTED_KINDS.has(job.kind)) throw new PermanentError(`unknown job kind ${JSON.stringify(job.kind)}`);
  if (job.simulateFailure) throw new Error("downstream service unavailable"); // transient -> retry
  return { kind: job.kind, id: job.id, status: "done" };
}

async function processRecord(record: EventRecord, ctx: Context): Promise<void> {
  try {
    const outcome = await handleJob(record.json<Job>());
    ctx.logger.info("job done", { messageId: record.id, ...outcome });
  } catch (err) {
    if (err instanceof PermanentError) {
      // Don't retry poison messages: acknowledge them (and alert / store them elsewhere).
      ctx.logger.error("dropping message", { messageId: record.id, reason: err.message });
      return;
    }
    throw err; // anything else is worth retrying -> reported as failed
  }
}

/**
 * `processBatch` runs the callback for every record (here 4 at a time) and collects
 * the records whose callback threw into a `BatchResult`.
 */
export const processJobs = defineHandler((event, ctx) =>
  processBatch(event.records, (record) => processRecord(record, ctx), {
    concurrency: 4,
    onError: (record, error) => ctx.logger.warn("job failed, will retry", { messageId: record.id, error }),
  }),
);

/** Consumes the dead-letter queue so failures are visible instead of silently piling up. */
export const auditDeadLetters = defineHandler((event, ctx) => {
  for (const record of event.records) {
    ctx.logger.error("dead letter", { messageId: record.id, body: record.text().slice(0, 1000), attributes: record.attributes });
  }
  return { audited: event.records.length };
});

/**
 * HTTP producer stub.
 *
 * Sending a message is a cloud SDK call (`@aws-sdk/client-sqs`, `@google-cloud/pubsub`,
 * `@azure/storage-queue`, ...). node_serverless_kit does not wrap these SDKs: keep that one
 * call behind a small function of your own (see README), so the rest stays portable.
 */
export const enqueue = defineHandler((event, ctx) => {
  const job = event.http?.json<Job>();
  if (!job || typeof job !== "object" || !job.kind) throw new BadRequest("`kind` is required");
  const queue = ctx.env.JOBS_QUEUE;
  ctx.logger.info("would enqueue", { job, queue });
  return HttpResponse.json({ accepted: true, queue }, 202);
});
