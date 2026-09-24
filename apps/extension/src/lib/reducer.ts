import type { ServerEvent, SessionInfo, SessionSnapshot, Side, StatusState } from '@live-ai/shared';

export interface DialogItem {
  /** `${side}:${turn}` — a partial and its final share the key. */
  key: string;
  side: Side;
  turn: number;
  text: string;
  ts: string;
  partial: boolean;
}

export interface SessionView {
  info: SessionInfo;
  items: DialogItem[];
  /** Keys that already received a final; later partials for them are ignored. */
  finalized: Record<string, true>;
  /** Latest degradation notice for this session (tap/transcription). */
  notice?: string;
}

export interface State {
  sessions: Record<string, SessionView>;
  /** Session ids in start order (oldest first). */
  order: string[];
  selectedId: string | null;
  ari: StatusState | null;
  /** Extensions to show; empty = all. */
  filter: string[];
}

export type Action =
  | { type: 'event'; event: ServerEvent }
  | { type: 'select'; id: string }
  | { type: 'clear'; id: string }
  | { type: 'setFilter'; extensions: string[] };

export function initialState(filter: string[] = []): State {
  return { sessions: {}, order: [], selectedId: null, ari: null, filter };
}

const itemKey = (side: Side, turn: number) => `${side}:${turn}`;

function passes(filter: string[], info: SessionInfo): boolean {
  return filter.length === 0 || filter.includes(info.extension);
}

function fromSnapshot(s: SessionSnapshot): SessionView {
  const { utterances, ...info } = s;
  const finalized: Record<string, true> = {};
  const items = utterances.map((u) => {
    const key = itemKey(u.side, u.turn);
    finalized[key] = true;
    return { key, side: u.side, turn: u.turn, text: u.text, ts: u.ts, partial: false };
  });
  return { info, items, finalized };
}

function latest(order: string[]): string | null {
  return order.at(-1) ?? null;
}

function withSession(state: State, id: string, fn: (s: SessionView) => SessionView): State {
  const cur = state.sessions[id];
  if (!cur) return state;
  return { ...state, sessions: { ...state.sessions, [id]: fn(cur) } };
}

function applyEvent(state: State, ev: ServerEvent): State {
  switch (ev.type) {
    case 'snapshot': {
      const kept = ev.sessions.filter((s) => passes(state.filter, s));
      const sessions: Record<string, SessionView> = {};
      for (const s of kept) sessions[s.id] = fromSnapshot(s);
      const order = [...kept].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((s) => s.id);
      const selectedId = state.selectedId && sessions[state.selectedId] ? state.selectedId : latest(order);
      return { ...state, sessions, order, selectedId, ari: ev.ari };
    }
    case 'session_started': {
      const info = ev.session;
      if (!passes(state.filter, info) || state.sessions[info.id]) return state;
      return {
        ...state,
        sessions: { ...state.sessions, [info.id]: { info, items: [], finalized: {} } },
        order: [...state.order, info.id],
        selectedId: info.id,
      };
    }
    case 'partial':
      return withSession(state, ev.sessionId, (s) => {
        const key = itemKey(ev.side, ev.turn);
        if (s.finalized[key]) return s;
        const idx = s.items.findIndex((i) => i.key === key);
        const items =
          idx >= 0
            ? s.items.map((i, n) => (n === idx ? { ...i, text: ev.text } : i))
            : [...s.items, { key, side: ev.side, turn: ev.turn, text: ev.text, ts: ev.ts, partial: true }];
        return { ...s, items };
      });
    case 'final':
      return withSession(state, ev.sessionId, (s) => {
        const key = itemKey(ev.side, ev.turn);
        const idx = s.items.findIndex((i) => i.key === key);
        const items =
          idx >= 0
            ? s.items.map((i, n) => (n === idx ? { ...i, text: ev.text, partial: false } : i))
            : [...s.items, { key, side: ev.side, turn: ev.turn, text: ev.text, ts: ev.ts, partial: false }];
        return { ...s, items, finalized: { ...s.finalized, [key]: true } };
      });
    case 'session_ended':
      return withSession(state, ev.sessionId, (s) => ({
        ...s,
        info: { ...s.info, state: ev.state, endedAt: ev.endedAt },
        // A partial that never got its final stays visible, but no longer as "in progress".
        items: s.items.map((i) => (i.partial ? { ...i, partial: false } : i)),
      }));
    case 'status':
      if (ev.scope === 'ari') return { ...state, ari: ev.state };
      if (!ev.sessionId) return state;
      return withSession(state, ev.sessionId, (s) => ({
        ...s,
        notice: ev.message ?? ev.state,
        info: ev.state === 'tap_failed' ? { ...s.info, state: 'tap_failed' } : s.info,
      }));
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event);
    case 'select':
      return state.sessions[action.id] ? { ...state, selectedId: action.id } : state;
    case 'clear': {
      const s = state.sessions[action.id];
      if (!s || s.info.state === 'active') return state;
      const { [action.id]: _removed, ...sessions } = state.sessions;
      const order = state.order.filter((id) => id !== action.id);
      const selectedId = state.selectedId === action.id ? latest(order) : state.selectedId;
      return { ...state, sessions, order, selectedId };
    }
    case 'setFilter': {
      const filter = action.extensions;
      const order = state.order.filter((id) => passes(filter, state.sessions[id]!.info));
      const sessions = Object.fromEntries(order.map((id) => [id, state.sessions[id]!]));
      const selectedId = state.selectedId && sessions[state.selectedId] ? state.selectedId : latest(order);
      return { ...state, filter, sessions, order, selectedId };
    }
  }
}
