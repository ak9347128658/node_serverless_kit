# 06 · Pub/sub topic: fan-out and filters (JavaScript)

Two subscribers on one topic, written in JavaScript with `// @ts-check` and JSDoc types.

| Function | Subscription | Receives |
| --- | --- | --- |
| `update-analytics` | `- topic: order-events` | every message |
| `notify-customer` | `- topic: {name: order-events, filter: {event_type: ["order.shipped"]}}` | only shipped orders |

Both functions subscribe to the same topic name, so nskit creates the topic once and one
subscription per function: every message reaches both (fan-out).

## Filters

`filter` is an SNS filter policy on message attributes. On clouds where nskit cannot express it
the handler repeats the check (`wants(record, ...)`), so behaviour is identical everywhere.
Attributes are available as `record.attributes` on every cloud.

## Run locally

```bash
npm install
npx nskit invoke -f notify-customer -e topic \
  -d '[{"body": {"orderId": "o-7", "email": "ada@example.com"}, "attributes": {"event_type": "order.shipped"}}]'
npx nskit invoke -f update-analytics -e topic -d '[{"body": {}, "attributes": {"event_type": "order.created"}}]'
```

## Publishing

Publishing is an SDK call in the producer (`@aws-sdk/client-sns` `PublishCommand` with
`MessageAttributes: {event_type: {DataType: "String", StringValue: "order.shipped"}}`,
`@google-cloud/pubsub` `topic.publishMessage({json, attributes})`, ...).

## Deploy

```bash
npx nskit deploy          # SNS topic + two Lambda subscriptions (one with a filter policy)
```

## Switch clouds

```bash
npx nskit deploy --provider gcp      # Pub/Sub topic + push subscriptions
npx nskit deploy --provider azure    # Service Bus topic + subscriptions
```
