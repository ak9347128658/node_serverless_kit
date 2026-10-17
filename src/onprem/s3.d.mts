export function signS3(input: {
  method: string;
  url: string;
  body?: string;
  accessKey: string;
  secretKey: string;
  region: string;
  now?: Date;
}): { authorization: string };
export function parseListObjects(xml: string): { objects: Array<{ key: string; size: number }> };
export function createS3Client(options: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}): { put(bucket: string, key: string, body: Uint8Array): Promise<void>; remove(bucket: string, key: string): Promise<void> };
