import { describe, expect, it } from 'vitest';
import type { ServerEvent, SessionInfo } from '@live-ai/shared';
import { initialState, reducer, type State } from './reducer';

const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, s)).toISOString();

const info = (id: string, extension = '222', s = 0): SessionInfo => ({
  id,
  extension,
  channelId: `ch-${id}`,
  remote: { name: '', number: '+44100' },
  startedAt: t(s),
  state: 'active',
});

const run = (events: ServerEvent[], state: State = initialState()) =>
  events.reduce((st, event) => reducer(st, { type: 'event', event }), state);

const started = (id: string, ext?: string, s?: number): ServerEvent => ({ type: 'session_started', session: info(id, ext, s) });

describe('reducer', () => {
  it('replaces a partial with the final of the same turn', () => {
    const st = run([
      started('s1'),
      { type: 'partial', sessionId: 's1', side: 'caller', turn: 0, text: 'hel', ts: t(1) },
      { type: 'partial', sessionId: 's1', side: 'caller', turn: 0, text: 'hello the', ts: t(1) },
      { type: 'final', sessionId: 's1', side: 'caller', turn: 0, text: 'Hello there.', ts: t(1) },
    ]);
    const items = st.sessions.s1!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'Hello there.', partial: false });
  });

  it('ignores a late partial for a finalized turn', () => {
    const st = run([
      started('s1'),
      { type: 'final', sessionId: 's1', side: 'agent', turn: 3, text: 'Done.', ts: t(1) },
      { type: 'partial', sessionId: 's1', side: 'agent', turn: 3, text: 'do', ts: t(2) },
    ]);
    expect(st.sessions.s1!.items).toEqual([expect.objectContaining({ text: 'Done.', partial: false })]);
  });

  it('keeps agent and caller turns with the same number separate', () => {
    const st = run([
      started('s1'),
      { type: 'final', sessionId: 's1', side: 'agent', turn: 0, text: 'Hi', ts: t(1) },
      { type: 'final', sessionId: 's1', side: 'caller', turn: 0, text: 'Hello', ts: t(2) },
    ]);
    expect(st.sessions.s1!.items.map((i) => i.text)).toEqual(['Hi', 'Hello']);
  });

  it('replaces state on snapshot and selects the latest session', () => {
    const before = run([started('old')]);
    const st = run(
      [
        {
          type: 'snapshot',
          ari: 'connected',
          sessions: [
            { ...info('a', '222', 5), utterances: [{ sessionId: 'a', side: 'agent', turn: 0, text: 'x', ts: t(6) }] },
            { ...info('b', '222', 1), utterances: [] },
          ],
        },
      ],
      before,
    );
    expect(Object.keys(st.sessions).sort()).toEqual(['a', 'b']);
    expect(st.order).toEqual(['b', 'a']);
    expect(st.selectedId).toBe('a');
    expect(st.ari).toBe('connected');
    expect(st.sessions.a!.finalized['agent:0']).toBe(true);
  });

  it('marks session ended but keeps the dialog', () => {
    const st = run([
      started('s1'),
      { type: 'final', sessionId: 's1', side: 'agent', turn: 0, text: 'Bye', ts: t(1) },
      { type: 'partial', sessionId: 's1', side: 'caller', turn: 0, text: 'by', ts: t(2) },
      { type: 'session_ended', sessionId: 's1', endedAt: t(3), state: 'ended' },
    ]);
    const s = st.sessions.s1!;
    expect(s.info.state).toBe('ended');
    expect(s.info.endedAt).toBe(t(3));
    expect(s.items).toHaveLength(2);
    expect(s.items.every((i) => !i.partial)).toBe(true);
    expect(st.selectedId).toBe('s1');
  });

  it('auto-selects the newest session', () => {
    const st = run([started('s1'), started('s2')]);
    expect(st.selectedId).toBe('s2');
  });

  it('filters sessions by extension', () => {
    const st = run([started('s1', '222'), started('s2', '333')], initialState(['222']));
    expect(Object.keys(st.sessions)).toEqual(['s1']);
    const refiltered = reducer(run([started('s1', '222'), started('s2', '333')]), { type: 'setFilter', extensions: ['333'] });
    expect(refiltered.order).toEqual(['s2']);
    expect(refiltered.selectedId).toBe('s2');
  });

  it('ignores events for unknown sessions', () => {
    const st = run([{ type: 'final', sessionId: 'nope', side: 'agent', turn: 0, text: 'x', ts: t(1) }]);
    expect(st.sessions).toEqual({});
  });

  it('clears only ended sessions', () => {
    let st = run([started('s1'), started('s2')]);
    expect(reducer(st, { type: 'clear', id: 's2' })).toBe(st);
    st = run([{ type: 'session_ended', sessionId: 's2', endedAt: t(9), state: 'ended' }], st);
    st = reducer(st, { type: 'clear', id: 's2' });
    expect(st.order).toEqual(['s1']);
    expect(st.selectedId).toBe('s1');
  });

  it('tracks ari status and per-session notices', () => {
    const st = run([
      started('s1'),
      { type: 'status', scope: 'ari', state: 'reconnecting' },
      { type: 'status', scope: 'transcription', state: 'transcription_degraded', sessionId: 's1', message: 'Transcription degraded' },
    ]);
    expect(st.ari).toBe('reconnecting');
    expect(st.sessions.s1!.notice).toBe('Transcription degraded');
  });
});
