import type { SessionInfo, SessionSnapshot, Side, Utterance } from '@live-ai/shared';

/** In-memory sessions with their final utterances; keeps at most `historyLimit` ended sessions. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionSnapshot>();

  constructor(private readonly historyLimit: number) {}

  add(info: SessionInfo): void {
    this.sessions.set(info.id, { ...info, utterances: [] });
  }

  get(id: string): SessionSnapshot | undefined {
    return this.sessions.get(id);
  }

  addFinal(u: Utterance): void {
    const s = this.sessions.get(u.sessionId);
    if (!s) return;
    const i = s.utterances.findIndex((x) => x.side === u.side && x.turn === u.turn);
    if (i >= 0) s.utterances[i] = u;
    else s.utterances.push(u);
  }

  update(id: string, patch: Partial<Pick<SessionInfo, 'state' | 'endedAt'>>): SessionSnapshot | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    Object.assign(s, patch);
    if (s.state === 'ended') this.evict();
    return s;
  }

  /** Active sessions first, then ended ones, newest first. */
  snapshot(filter?: (s: SessionInfo) => boolean): SessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((s) => !filter || filter(s))
      .sort((a, b) => Number(a.state === 'ended') - Number(b.state === 'ended') || b.startedAt.localeCompare(a.startedAt))
      .map((s) => ({ ...s, utterances: [...s.utterances] }));
  }

  get activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.state !== 'ended').length;
  }

  private evict(): void {
    const ended = [...this.sessions.values()]
      .filter((s) => s.state === 'ended')
      .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''));
    while (ended.length > this.historyLimit) this.sessions.delete(ended.shift()!.id);
  }
}

export type { Side };
