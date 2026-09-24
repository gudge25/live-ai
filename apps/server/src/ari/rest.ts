import { readFileSync } from 'node:fs';
import { Agent, type Dispatcher } from 'undici';
import type { AriBridge, AriChannel } from './types.js';

export interface AriConnectionOptions {
  /** Base URL, e.g. https://pbx:8089 (no /ari suffix). */
  url: string;
  user: string;
  password: string;
  app: string;
  caCertPath?: string;
  tlsInsecure?: boolean;
}

export class AriHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`ARI ${method} ${path} -> ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'AriHttpError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export function tlsOptions(opts: Pick<AriConnectionOptions, 'caCertPath' | 'tlsInsecure'>): { ca?: Buffer; rejectUnauthorized: boolean } {
  return {
    ca: opts.caCertPath ? readFileSync(opts.caCertPath) : undefined,
    rejectUnauthorized: !opts.tlsInsecure,
  };
}

/** The ARI REST operations this service needs. */
export interface AriApi {
  readonly app: string;
  getChannel(id: string): Promise<AriChannel>;
  listChannels(): Promise<AriChannel[]>;
  getChannelVar(channelId: string, variable: string): Promise<string | undefined>;
  hangupChannel(id: string): Promise<void>;
  snoopChannel(channelId: string, params: { snoopId: string; spy: 'in' | 'out' | 'both' }): Promise<AriChannel>;
  createExternalMedia(params: { channelId: string; externalHost: string; data: string; format: string }): Promise<AriChannel>;
  createBridge(params: { bridgeId: string; name: string }): Promise<AriBridge>;
  listBridges(): Promise<AriBridge[]>;
  addChannelsToBridge(bridgeId: string, channelIds: string[]): Promise<void>;
  destroyBridge(id: string): Promise<void>;
  subscribe(eventSources: string[]): Promise<void>;
}

export class AriRest implements AriApi {
  readonly app: string;
  private readonly base: string;
  private readonly auth: string;
  private readonly dispatcher?: Dispatcher;

  constructor(opts: AriConnectionOptions) {
    this.app = opts.app;
    this.base = `${opts.url.replace(/\/+$/, '')}/ari`;
    this.auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
    if (this.base.startsWith('https:') && (opts.caCertPath || opts.tlsInsecure)) {
      this.dispatcher = new Agent({ connect: tlsOptions(opts) });
    }
  }

  private async request<T>(method: string, path: string, query: Query = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: this.auth, accept: 'application/json' },
      // @ts-expect-error undici dispatcher is supported by Node's fetch
      dispatcher: this.dispatcher,
    });
    const text = await res.text();
    if (!res.ok) throw new AriHttpError(res.status, method, path, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** DELETE that treats 404 (already gone) as success. */
  private async remove(path: string): Promise<void> {
    try {
      await this.request('DELETE', path);
    } catch (e) {
      if (e instanceof AriHttpError && e.status === 404) return;
      throw e;
    }
  }

  getChannel(id: string) {
    return this.request<AriChannel>('GET', `/channels/${encodeURIComponent(id)}`);
  }

  listChannels() {
    return this.request<AriChannel[]>('GET', '/channels');
  }

  async getChannelVar(channelId: string, variable: string): Promise<string | undefined> {
    try {
      const r = await this.request<{ value: string }>('GET', `/channels/${encodeURIComponent(channelId)}/variable`, { variable });
      return r.value || undefined;
    } catch (e) {
      if (e instanceof AriHttpError && e.status === 404) return undefined;
      throw e;
    }
  }

  hangupChannel(id: string) {
    return this.remove(`/channels/${encodeURIComponent(id)}`);
  }

  snoopChannel(channelId: string, p: { snoopId: string; spy: 'in' | 'out' | 'both' }) {
    return this.request<AriChannel>('POST', `/channels/${encodeURIComponent(channelId)}/snoop`, {
      app: this.app,
      spy: p.spy,
      whisper: 'none',
      snoopId: p.snoopId,
    });
  }

  createExternalMedia(p: { channelId: string; externalHost: string; data: string; format: string }) {
    return this.request<AriChannel>('POST', '/channels/externalMedia', {
      app: this.app,
      channelId: p.channelId,
      external_host: p.externalHost,
      encapsulation: 'audiosocket',
      transport: 'tcp',
      format: p.format,
      data: p.data,
    });
  }

  createBridge(p: { bridgeId: string; name: string }) {
    return this.request<AriBridge>('POST', '/bridges', { type: 'mixing', bridgeId: p.bridgeId, name: p.name });
  }

  listBridges() {
    return this.request<AriBridge[]>('GET', '/bridges');
  }

  async addChannelsToBridge(bridgeId: string, channelIds: string[]) {
    await this.request('POST', `/bridges/${encodeURIComponent(bridgeId)}/addChannel`, { channel: channelIds.join(',') });
  }

  destroyBridge(id: string) {
    return this.remove(`/bridges/${encodeURIComponent(id)}`);
  }

  async subscribe(eventSources: string[]) {
    if (eventSources.length === 0) return;
    await this.request('POST', `/applications/${encodeURIComponent(this.app)}/subscription`, { eventSource: eventSources.join(',') });
  }
}
