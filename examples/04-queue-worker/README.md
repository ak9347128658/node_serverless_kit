# 04 · Queue worker

A batch consumer with partial failures, a dead-letter queue and an HTTP producer stub.

| Function | Trigger | Shows |
| --- | --- | --- |
| `process-jobs` | queue `jobs` (`batchSize: 10`, `batchWindow: 5`, `deadLetter: jobs-dlq`, `maxReceive: 5`) | `processBatch` / `BatchResult`, poison messages |
| `audit-dead-letters` | queue `jobs-dlq` | reading the DLQ |
| `enqueue` | `POST /jobs` | returning `202 Accepted` |

## Partial batch failures

```ts
export const processJobs = defineHandler((event, ctx) =>
  processBatch(event.records, (record) => processRecord(record, ctx), { concurrency: 4 }),
);
```

`processBatch` returns a `BatchResult` listing the records whose callback threw. You can also
build it by hand: `const result = new BatchResult(); result.fail(record); return result;`.

- **AWS SQS** retries only the failed messages (`batchItemFailures`).
- **Other clouds** have no partial acknowledgement: any failure fails the whole invocation, so the
  batch is redelivered. Keep processing idempotent.

Errors that retrying cannot fix (`PermanentError`, e.g. an unknown job kind) are logged and
acknowledged instead of being retried until they reach the DLQ.

## Producing messages

Publishing is a cloud SDK call. Wrap it in one function and pick the implementation by
`process.env.NSKIT_PROVIDER`:

```ts
export async function sendJob(job: Job) {
  switch (process.env.NSKIT_PROVIDER) {
    case "aws": {
      const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
      await new SQSClient({}).send(new SendMessageCommand({ QueueUrl: process.env.JOBS_QUEUE_URL, MessageBody: JSON.stringify(job) }));
      break;
    }
    // case "gcp": @google-cloud/pubsub ... case "azure": @azure/storage-queue ...
  }
}
```

## Run locally

```bash
npm install
npx nskit invoke -f process-jobs -e queue -d '[{"kind": "email"}, {"kind": "email", "simulateFailure": true}, {"kind": "nope"}]'
# -> {"failed": ["2"]}: message 2 is retried, message 3 is dropped as poison
curl -X POST localhost:3000/jobs -d '{"kind": "email"}'      # after `npx nskit dev`
```

## Deploy

```bash
npx nskit deploy          # SQS queue + DLQ + redrive policy + event source mapping
```

## Switch clouds

```bash
npx nskit deploy --provider gcp      # Pub/Sub topic + push subscription + dead-letter topic
npx nskit deploy --provider azure    # Storage queue trigger (poison queue is automatic)
```
