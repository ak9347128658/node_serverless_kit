# 05 · Storage events

React to objects being created or deleted in a bucket.

| Function | Trigger | Shows |
| --- | --- | --- |
| `import-csv` | `created` in `${self:custom.bucket}`, `prefix: incoming/`, `suffix: .csv` | filters, size checks |
| `purge-index` | `deleted` in the same bucket | keeping an index in sync |
| `audit-existing` | `created` + `deleted` on a bucket with `existing: true` | attaching to a bucket nskit does not own |

## The YAML

```yaml
custom:
  bucket: "${env:DATA_BUCKET, storage-events-data-demo-1234}-${opt:stage}"   # globally unique names

functions:
  import-csv:
    events:
      - storage:
          bucket: "${self:custom.bucket}"
          events: [created]          # created | deleted
          prefix: incoming/
          suffix: .csv
```

With `existing: false` (the default) nskit creates the bucket; `existing: true` only looks it up
and never deletes it.

## The records

Every cloud's notification becomes the same `EventRecord`: `bucket`, `key` (URL-decoded),
`size` and `action` (`"created" | "deleted"`). Downloading the object is a cloud SDK call kept
outside the handler logic.

## Run locally

```bash
npm install
npx nskit invoke -f import-csv -e storage -d '[{"key": "incoming/sales.csv", "size": 1024}]'
npx nskit invoke -f purge-index -e storage -d '[{"key": "incoming/sales.csv", "action": "deleted"}]'
```

## Deploy

```bash
DATA_BUCKET=acme-imports npx nskit deploy      # bucket acme-imports-dev + S3 notifications
```

## Switch clouds

```bash
npx nskit deploy --provider gcp      # Cloud Storage + Eventarc
npx nskit deploy --provider azure    # Blob triggers (no delete events, see providers.azure)
```

Azure blob triggers cannot fire on deletions, so `providers.azure` deploys `purge-index` without a
trigger and points `audit-existing` at an app-owned container. That decision is explicit in the
config instead of silently dropped.
