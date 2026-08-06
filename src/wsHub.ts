import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import type session from 'express-session';
import { WebSocketServer, WebSocket } from 'ws';
import { resolveDisplayDevice } from './models/location-config.model.js';

type Client = WebSocket & { topics?: Set<string> };
type AttachOptions = {
  sessionCookieName: string;
  sessionSecret: string;
  sessionStore: session.Store;
};

export class WsHub {
  private wss?: WebSocketServer;
  private options?: AttachOptions;

  attach(server: Server, options: AttachOptions) {
    this.options = options;
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket: Client, req) => {
      socket.topics = new Set();
      socket.on('message', raw => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
            this.authorizeTopics(req, msg.topics.map(String), String(msg.deviceToken || '')).then(topics => {
              socket.topics = topics;
              socket.send(JSON.stringify({ type: 'subscribed', topics: [...topics] }));
            }).catch(err => {
              socket.topics = new Set();
              socket.send(JSON.stringify({ type: 'error', message: err.message || 'Unauthorized websocket subscription' }));
            });
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

  private async authorizeTopics(req: IncomingMessage, requestedTopics: string[], deviceToken: string) {
    if (deviceToken) {
      const device = await resolveDisplayDevice(deviceToken, socketIp(req));
      if (!device) throw new Error('Invalid display device token');
      const allowed = new Set((device.room_ids || []).map((id: string) => `room:${id}`));
      allowed.add(`location:${device.location_id}`);
      return new Set(requestedTopics.filter(topic => allowed.has(topic)));
    }

    const user = await this.sessionUser(req);
    if (!user) throw new Error('Unauthorized websocket subscription');
    if (user.roles?.includes('admin')) return new Set(requestedTopics);
    return new Set(requestedTopics.filter(topic => topic === 'queue:all' || topic.startsWith('location:') || topic.startsWith('room:')));
  }

  private async sessionUser(req: IncomingMessage) {
    const sid = this.sessionIdFromCookie(req.headers.cookie || '');
    if (!sid || !this.options) return null;
    return new Promise<any>((resolve) => {
      this.options!.sessionStore.get(sid, (_err, sess) => resolve(sess?.user || null));
    });
  }

  private sessionIdFromCookie(cookieHeader: string) {
    if (!this.options) return '';
    const cookies = parseCookies(cookieHeader);
    const raw = cookies[this.options.sessionCookieName];
    if (!raw) return '';
    const decoded = decodeURIComponent(raw);
    if (!decoded.startsWith('s:')) return decoded;
    const signedValue = decoded.slice(2);
    const dot = signedValue.lastIndexOf('.');
    if (dot < 1) return '';
    const value = signedValue.slice(0, dot);
    return secureCompare(sign(value, this.options.sessionSecret), signedValue) ? value : '';
  }
}

export const wsHub = new WsHub();

function parseCookies(header: string) {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function sign(value: string, secret: string) {
  const sig = crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
  return `${value}.${sig}`;
}

function secureCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function socketIp(req: IncomingMessage) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}
