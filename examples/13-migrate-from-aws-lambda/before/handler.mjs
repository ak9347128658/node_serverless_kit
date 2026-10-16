// BEFORE: a typical AWS-only Lambda code base (do not deploy with nskit).
//
// Everything AWS-specific is mixed into the business logic: API Gateway event
// parsing, statusCode/body objects, SQS record loops, AWS SDK Step Functions calls.

import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const sfn = new SFNClient({});

export const createOrderHandler = async (event) => {
  // API Gateway REST (payload v1) parsing
  let body = event.body ?? "{}";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf-8");
  let order;
  try {
    order = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid json" }) };
  }
  if (!order.items?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "items required" }) };
  }
  order.total = order.items.reduce((sum, i) => sum + i.qty * i.price, 0);

  // Start the Step Functions workflow directly
  const execution = await sfn.send(
    new StartExecutionCommand({ stateMachineArn: process.env.ORDER_STATE_MACHINE_ARN, input: JSON.stringify(order) }),
  );
  return {
    statusCode: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ execution: execution.executionArn }),
  };
};

export const getOrderHandler = async (event) => {
  const id = event.pathParameters?.id;
  if (!id) return { statusCode: 404, body: JSON.stringify({ error: "not found" }) };
  return { statusCode: 200, body: JSON.stringify({ id, status: "unknown" }) };
};

export const emailWorkerHandler = async (event) => {
  // SQS batch with partial failure reporting
  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      if (!message.to) throw new Error("no recipient");
      console.log("sending email to", message.to);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

// Step Functions task Lambdas receive the raw state as the event.
export const validateTask = async (event) => {
  if (event.items.reduce((n, i) => n + i.qty, 0) <= 0) {
    const err = new Error("empty order");
    err.name = "ValidationError";
    throw err;
  }
  return { ...event, valid: true };
};

export const chargeTask = async (event) => ({ ...event, charged: true });
