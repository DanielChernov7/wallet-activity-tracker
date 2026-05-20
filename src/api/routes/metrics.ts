import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { metrics } from '../../metrics/index.js';

const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export async function metricsRoute(app: FastifyInstance): Promise<void> {
  const m = metrics();
  const user = env.METRICS_AUTH_USER;
  const pass = env.METRICS_AUTH_PASS;
  const authRequired = Boolean(user && pass);

  app.get('/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    if (authRequired && !checkAuth(req, user!, pass!)) {
      reply.header('www-authenticate', 'Basic realm="metrics"');
      return reply.code(401).send('unauthorized');
    }
    const body = await m.registry.metrics();
    reply.header('content-type', PROM_CONTENT_TYPE);
    return reply.send(body);
  });
}

function checkAuth(req: FastifyRequest, user: string, pass: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('basic ')) return false;
  const encoded = header.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass;
}
