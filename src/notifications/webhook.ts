import { request } from 'undici';

export async function sendWebhook(url: string, payload: unknown): Promise<void> {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`webhook ${url} -> ${res.statusCode}: ${text}`);
  }
}
