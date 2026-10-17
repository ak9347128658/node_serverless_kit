/**
 * The same handlers run on-premises and on any cloud that supports the trigger.
 * `sendMessage` / `publishEvent` / `putObject` use the on-premises bus. Locally
 * (`nskit dev`, tests) they use an in-memory bus. On a cloud, call that cloud's SDK.
 */

import { BadRequest, BatchResult, defineHandler, getEnv, HttpResponse, publishEvent, putObject, sendMessage } from "node_serverless_kit";

export const api = defineHandler(async (event) => {
  if (event.http?.method === "POST") {
    const job = event.http.json<{ kind?: string }>();
    if (!job?.kind) throw new BadRequest("kind is required");
    const id = await sendMessage("jobs", job);
    return HttpResponse.json({ accepted: true, id }, 202);
  }
  return { ok: true, provider: event.provider, label: getEnv("FN_LABEL", ""), service: getEnv("SERVICE_LABEL", "") };
});

/** Ack the records that parsed; the rest are retried, then dead-lettered. */
export const worker = defineHandler((event) => {
  const result = new BatchResult();
  for (const record of event.records) {
    const job = record.json<{ kind?: string }>();
    if (!job?.kind) result.fail(record);
  }
  return result;
});

export const audit = defineHandler((event) => ({ audited: event.records.length }));

export const notify = defineHandler(async (event) => {
  const sent: string[] = [];
  for (const record of event.records) {
    const type = String(record.attributes.type ?? "");
    if (type !== "created") continue;
    sent.push(String(record.json<{ id?: string }>()?.id ?? record.id));
  }
  return { sent };
});

export const files = defineHandler((event) => ({
  seen: event.records.map((record) => ({ key: record.key, action: record.action })),
}));

export const tick = defineHandler((event) => ({ ran: true, input: event.data }));

export const echo = defineHandler((event) => event.data);

/** Used by the README: publish and store from inside the process. */
export const fanout = defineHandler(async (event) => {
  const body = event.data ?? {};
  const eventId = await publishEvent("events", body, { type: "created" });
  await putObject("uploads", "in/note.txt", JSON.stringify(body));
  return { eventId };
});
