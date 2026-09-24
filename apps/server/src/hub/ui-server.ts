import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { parseClientMessage, WS_CLOSE_UNAUTHORIZED, type ServerEvent, type StatusState } from '@live-ai/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from '../logger.js';
import type { SessionStore } from './session-store.js';

interface Client {
  ws: WebSocket;
  /** Empty = all extensions. */
  extensions: Set<string>;
}

export interface UiServerOptions {
  token: string;
  store: SessionStore;
  log: Logger;
  ariStatus: () => StatusState;
}

function tokenOk(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const parseExt = (v: string | null) =>
  new Set(
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** HTTP server with `/healthz` and the `/ui` WebSocket that streams transcript events. */
export class UiServer {
  readonly http: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<Client>();

  constructor(private readonly o: UiServerOptions) {
    this.http = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ari: o.ariStatus(), activeSessions: o.store.activeCount }));
        return;
      }
      res.writeHead(404).end();
    });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ui') {
        socket.destroy();
        return;
      }
      // Accept first and then close with 4401, so browsers can see why (an HTTP 401 shows up as 1006).
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (!tokenOk(url.searchParams.get('token'), o.token)) {
          o.log.warn({ remote: req.socket.remoteAddress }, 'UI: unauthorized connection');
          ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        this.onClient(ws, parseExt(url.searchParams.get('ext')));
      });
    });
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        const a = this.http.address();
        resolve(typeof a === 'object' && a ? a.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.ws.terminate();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  /** Send to every client subscribed to the session's extension (or all for global events). */
  broadcast(ev: ServerEvent, extension?: string): void {
    const data = JSON.stringify(ev);
    for (const c of this.clients) {
      if (extension && c.extensions.size && !c.extensions.has(extension)) continue;
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  private onClient(ws: WebSocket, extensions: Set<string>): void {
    const client: Client = { ws, extensions };
    this.clients.add(client);
    this.o.log.info({ extensions: [...extensions], clients: this.clients.size }, 'UI client connected');
    this.sendSnapshot(client);

    ws.on('message', (raw) => {
      try {
        const msg = parseClientMessage(JSON.parse(String(raw)));
        if (msg.type === 'subscribe') {
          client.extensions = new Set(msg.extensions);
          this.sendSnapshot(client);
        }
      } catch {
        this.o.log.debug('UI: ignoring invalid client message');
      }
    });
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  private sendSnapshot(c: Client): void {
    const sessions = this.o.store.snapshot((s) => !c.extensions.size || c.extensions.has(s.extension));
    const ev: ServerEvent = { type: 'snapshot', sessions, ari: this.o.ariStatus() };
    c.ws.send(JSON.stringify(ev));
  }
}
