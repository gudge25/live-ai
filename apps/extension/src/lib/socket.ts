import { parseServerEvent, WS_CLOSE_UNAUTHORIZED, type ServerEvent } from '@live-ai/shared';
import { buildSocketUrl, parseExtensions, type Settings } from './settings';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'unauthorized';

export interface SocketCallbacks {
  onEvent: (ev: ServerEvent) => void;
  onState: (state: ConnectionState, detail?: string) => void;
}

const MIN_DELAY = 1_000;
const MAX_DELAY = 15_000;
/** After a 4401 we keep retrying, but slowly: the token may be fixed on the server side. */
const UNAUTHORIZED_DELAY = 30_000;

/**
 * WebSocket client for the backend /ui endpoint. Lives in the page (side panel / pop-out),
 * not in the MV3 service worker, which Chrome suspends. Reconnects with exponential backoff.
 * A settings change creates a new instance, so it reconnects immediately.
 */
export class TranscriptSocket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = MIN_DELAY;
  private stopped = false;

  constructor(
    private readonly settings: Settings,
    private readonly cb: SocketCallbacks,
  ) {}

  start(): void {
    this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000);
    this.ws = null;
  }

  private connect(isRetry: boolean): void {
    if (this.stopped) return;
    let url: string;
    try {
      url = buildSocketUrl(this.settings);
    } catch (err) {
      this.cb.onState('disconnected', (err as Error).message);
      return;
    }
    this.cb.onState(isRetry ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.delay = MIN_DELAY;
      this.cb.onState('connected');
      ws.send(JSON.stringify({ type: 'subscribe', extensions: parseExtensions(this.settings.extensions) }));
    };
    ws.onmessage = (msg) => {
      try {
        this.cb.onEvent(parseServerEvent(JSON.parse(String(msg.data))));
      } catch {
        // Invalid or unknown event: drop it rather than break the view.
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      if (e.code === WS_CLOSE_UNAUTHORIZED) {
        this.cb.onState('unauthorized', 'Unauthorized — check token');
        this.schedule(UNAUTHORIZED_DELAY);
        return;
      }
      this.cb.onState('reconnecting');
      this.schedule(this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY);
    };
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(true), ms);
  }
}
