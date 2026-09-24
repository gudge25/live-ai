import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Logger } from '../logger.js';
import { tlsOptions, type AriConnectionOptions } from './rest.js';

export type AriLinkStatus = 'connected' | 'reconnecting' | 'disconnected';

export interface AriEventStreamOptions extends AriConnectionOptions {
  subscribeAll?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface AriEventStreamEvents {
  event: [Record<string, unknown> & { type: string }];
  status: [AriLinkStatus];
  /** Fired after every successful (re)connect; handlers re-establish subscriptions. */
  connected: [];
}

/** Persistent ARI events WebSocket with exponential backoff reconnect. */
export class AriEventStream extends EventEmitter<AriEventStreamEvents> {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private _status: AriLinkStatus = 'disconnected';
  private readonly initialDelay: number;
  private readonly maxDelay: number;

  constructor(
    private readonly opts: AriEventStreamOptions,
    private readonly log: Logger,
  ) {
    super();
    this.initialDelay = opts.initialDelayMs ?? 1000;
    this.maxDelay = opts.maxDelayMs ?? 30_000;
  }

  get status(): AriLinkStatus {
    return this._status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.setStatus('disconnected');
  }

  /** Delay for the n-th retry (0-based), capped at maxDelay. */
  static backoff(attempt: number, initial: number, max: number): number {
    return Math.min(max, initial * 2 ** attempt);
  }

  private url(): string {
    const u = new URL(this.opts.url.replace(/\/+$/, '') + '/ari/events');
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('app', this.opts.app);
    u.searchParams.set('subscribeAll', String(Boolean(this.opts.subscribeAll)));
    return u.toString();
  }

  private connect(): void {
    const auth = Buffer.from(`${this.opts.user}:${this.opts.password}`).toString('base64');
    const ws = new WebSocket(this.url(), {
      headers: { authorization: `Basic ${auth}` },
      ...(this.opts.url.startsWith('https:') ? tlsOptions(this.opts) : {}),
    });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.log.info({ app: this.opts.app }, 'ARI events connected');
      this.setStatus('connected');
      this.emit('connected');
    });
    ws.on('message', (data) => {
      try {
        const ev = JSON.parse(String(data));
        if (ev && typeof ev.type === 'string') this.emit('event', ev);
      } catch (e) {
        this.log.warn({ err: e }, 'ARI: failed to parse event');
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) this.log.error('ARI authentication failed (401): check ARI_USER / ARI_PASSWORD');
      else this.log.error({ status: res.statusCode }, 'ARI events: unexpected HTTP response');
      ws.terminate();
    });
    ws.on('error', (err) => this.log.warn({ err: err.message }, 'ARI events socket error'));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = AriEventStream.backoff(this.attempt++, this.initialDelay, this.maxDelay);
    this.setStatus('reconnecting');
    this.log.info({ delayMs: delay, attempt: this.attempt }, 'ARI events: reconnecting');
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private setStatus(s: AriLinkStatus) {
    if (s === this._status) return;
    this._status = s;
    this.emit('status', s);
  }
}
