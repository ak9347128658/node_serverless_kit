/**
 * Object storage notifications (S3, Cloud Storage, Blob Storage, OSS, COS, OBS, ...).
 *
 * Every record exposes the same fields on every cloud:
 *
 *   record.bucket   bucket / container name
 *   record.key      object key (URL-decoded)
 *   record.size     bytes (undefined for deletions on some clouds)
 *   record.action   "created" | "deleted"
 *
 * Reading the object itself is a cloud SDK call (@aws-sdk/client-s3,
 * @google-cloud/storage, @azure/storage-blob, ...); this example only inspects
 * the notification.
 */

import { defineHandler } from "node-serverless-kit";

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

function datasetOf(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Triggered for new `incoming/*.csv` objects (prefix/suffix filters are applied by the cloud). */
export const importCsv = defineHandler((event, ctx) => {
  const accepted: { bucket?: string; key?: string; dataset: string }[] = [];
  const skipped: { key?: string; reason: string }[] = [];
  for (const record of event.records) {
    if (record.action !== "created" || !record.key) continue;
    if (record.size !== undefined && record.size > MAX_IMPORT_BYTES) {
      skipped.push({ key: record.key, reason: "too large" });
      continue;
    }
    const dataset = datasetOf(record.key);
    ctx.logger.info("importing", { bucket: record.bucket, key: record.key, dataset });
    accepted.push({ bucket: record.bucket, key: record.key, dataset });
  }
  return { accepted, skipped };
});

/** Triggered when an object is deleted - keep a search index / cache in sync. */
export const purgeIndex = defineHandler((event, ctx) => {
  const removed = event.records.filter((r) => r.action === "deleted").map((r) => r.key);
  ctx.logger.info("removing from index", { keys: removed });
  return { removed };
});

/** Listens to a bucket that is managed elsewhere (`existing: true`). */
export const auditExistingBucket = defineHandler((event, ctx) => {
  for (const record of event.records) {
    ctx.logger.info("object event", { bucket: record.bucket, key: record.key, action: record.action, size: record.size });
  }
  return { seen: event.records.length };
});
