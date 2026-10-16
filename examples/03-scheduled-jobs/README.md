# 03 · Scheduled jobs (JavaScript)

Three cron-style jobs written in plain JavaScript (ES modules, no build step of your own):

| Function | Schedule | Shows |
| --- | --- | --- |
| `heartbeat` | `- schedule: 5 minutes` | the rate shorthand |
| `daily-report` | `cron: "0 9 * * 1-5"` in `Europe/Berlin` + a named `weekly` schedule | 5-field cron, `timezone`, `input`, several schedules per function |
| `cleanup` | `rate: 1 day`, `enabled: true` | pausing a schedule, `ctx.remainingTimeMs()` |

## Schedule syntax

```yaml
events:
  - schedule: 5 minutes                 # rate: <n> minute(s) | hour(s) | day(s)
  - schedule: "0 9 * * 1-5"             # anything else is a standard 5-field cron
  - schedule:
      cron: "0 9 * * 1-5"
      timezone: Europe/Berlin           # IANA name, default UTC
      input: {report: sales, days: 1}   # -> event.data
      enabled: false                    # keep the trigger, stop firing
```

nskit translates the expression for each cloud (EventBridge Scheduler, Cloud Scheduler, Azure
timer triggers with 6-field NCRONTAB, ...). Clouds without time-zone support run the schedule in UTC
(check `nskit validate --provider <cloud>` for warnings).

## The handlers

`event.data` is the configured `input`, `event.time` is the firing time. A job that throws is
retried by the platform, so keep jobs idempotent. Long jobs should watch
`ctx.remainingTimeMs()` and stop before the platform timeout (it is `undefined` locally).

## Run locally

```bash
npm install
npx nskit invoke -f heartbeat
npx nskit invoke -f daily-report -d '{"report": "sales", "days": 7}'
npx nskit invoke -f cleanup -d '{"retentionDays": 30}'
```

## Deploy

```bash
npx nskit deploy
```

## Switch clouds

```bash
npx nskit deploy --provider gcp      # Cloud Scheduler -> Cloud Functions
npx nskit deploy --provider azure    # timer triggers; cleanup timeout lowered to 600 s by providers.azure
```
