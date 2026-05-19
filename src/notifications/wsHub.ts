import type { WebSocket } from '@fastify/websocket';

/**
 * Simple in-process pub/sub hub for fan-out to connected WS clients.
 * For multi-instance deployments, back this with Redis pub/sub.
 */
class WsHub {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
  }

  broadcast(event: string, data: unknown): void {
    const msg = JSON.stringify({ event, data, ts: Date.now() });
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  size(): number {
    return this.clients.size;
  }
}

export const wsHub = new WsHub();
