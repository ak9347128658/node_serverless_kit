/**
 * Small S3 / MinIO client (SigV4, path-style) used when on-premises storage
 * is MinIO or an existing S3 endpoint. Listing is enough to emit created and
 * deleted events; the handler still receives the portable storage record.
 */

import { createHash, createHmac } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function signS3({ method, url, body = "", accessKey, secretKey, region, now = new Date() }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers = { host: target.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...target.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
  const canonical = [method, target.pathname || "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function parseListObjects(xml) {
  const objects = [];
  const blocks = String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
  for (const block of blocks) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block[1]);
    const size = /<Size>(\d+)<\/Size>/.exec(block[1]);
    if (!key) continue;
    objects.push({ key: key[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), size: size ? Number(size[1]) : 0 });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
  return { objects, truncated, token: token ? token[1] : "" };
}

export function createS3Client({ endpoint, accessKey, secretKey, region = "us-east-1" }) {
  const root = String(endpoint).replace(/\/+$/, "");
  async function call(method, pathname, query = "") {
    const url = `${root}${pathname}${query ? `?${query}` : ""}`;
    const headers = signS3({ method, url, accessKey, secretKey, region });
    const resp = await fetch(url, { method, headers });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`s3 ${method} ${pathname} -> ${resp.status}: ${text.slice(0, 300)}`);
    return text;
  }
  function objectPath(bucket, key) {
    return `/${encodeURIComponent(bucket)}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
  }
  return {
    async put(bucket, key, body) {
      const pathname = objectPath(bucket, key);
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
      const url = `${root}${pathname}`;
      const headers = signS3({ method: "PUT", url, body: payload, accessKey, secretKey, region });
      const resp = await fetch(url, { method: "PUT", headers, body: payload });
      if (!resp.ok) throw new Error(`s3 PUT ${pathname} -> ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    },
    async remove(bucket, key) {
      const pathname = objectPath(bucket, key);
      const url = `${root}${pathname}`;
      const headers = signS3({ method: "DELETE", url, accessKey, secretKey, region });
      const resp = await fetch(url, { method: "DELETE", headers });
      if (!resp.ok && resp.status !== 404) throw new Error(`s3 DELETE ${pathname} -> ${resp.status}`);
    },
    async list(bucket, prefix = "") {
      const objects = [];
      let token = "";
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ "list-type": "2" });
        if (prefix) query.set("prefix", prefix);
        if (token) query.set("continuation-token", token);
        const xml = await call("GET", `/${encodeURIComponent(bucket)}`, query.toString());
        const parsed = parseListObjects(xml);
        objects.push(...parsed.objects);
        if (!parsed.truncated || !parsed.token) break;
        token = parsed.token;
      }
      return objects;
    },
  };
}
