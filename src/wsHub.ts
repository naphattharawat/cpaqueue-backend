import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

type Client = WebSocket & { topics?: Set<string> };

export class WsHub {
  private wss?: WebSocketServer;

  attach(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket: Client) => {
      socket.topics = new Set(['queue:all']);
      socket.on('message', raw => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
            socket.topics = new Set(['queue:all', ...msg.topics.map(String)]);
          }
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid websocket message' }));
        }
      });
    });
  }

  broadcastQueueChanged(payload: Record<string, unknown>) {
    this.broadcast(['queue:all', `location:${payload.locationId}`, `room:${payload.roomId}`], {
      type: 'queue.changed',
      payload,
      at: new Date().toISOString(),
    });
  }

  private broadcast(topics: string[], data: unknown) {
    const text = JSON.stringify(data);
    this.wss?.clients.forEach(client => {
      const c = client as Client;
      if (c.readyState === WebSocket.OPEN && topics.some(t => c.topics?.has(t))) {
        c.send(text);
      }
    });
  }
}

export const wsHub = new WsHub();
