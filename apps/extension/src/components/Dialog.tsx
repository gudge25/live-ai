import { useLayoutEffect, useRef, useState } from 'react';
import type { Side } from '@live-ai/shared';
import type { SessionView } from '../lib/reducer';

const STICK_THRESHOLD_PX = 40;

export function Dialog({ session, labels }: { session: SessionView; labels: Record<Side, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const lastText = session.items.at(-1)?.text;
  // Content "version": changes when a bubble is added or the last one grows.
  const contentKey = `${session.items.length}:${lastText ?? ''}`;
  // Content version at the moment the user scrolled away from the bottom.
  const [seenKey, setSeenKey] = useState(contentKey);
  const hasNew = !stick && contentKey !== seenKey;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [contentKey, stick]);

  const onScroll = () => {
    const el = ref.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
    if (!atBottom && stick) setSeenKey(contentKey);
    setStick(atBottom);
  };

  const jump = () => {
    const el = ref.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setStick(true);
  };

  const ended = session.info.state !== 'active';

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full space-y-2 overflow-y-auto px-3 py-3">
        {session.notice && (
          <div className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
            {session.notice}
          </div>
        )}
        {session.items.length === 0 && !ended && (
          <p className="pt-6 text-center text-xs text-slate-500 dark:text-slate-400">Listening…</p>
        )}
        {session.items.map((item) => (
          <Bubble key={item.key} side={item.side} label={labels[item.side]} ts={item.ts} text={item.text} partial={item.partial} />
        ))}
        {ended && (
          <div className="flex items-center gap-2 pt-2 text-[11px] uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            {session.info.state === 'tap_failed' ? 'Could not attach to call' : 'Call ended'}
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          </div>
        )}
      </div>
      {!stick && hasNew && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white shadow-lg hover:bg-indigo-500"
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

function Bubble({ side, label, ts, text, partial }: { side: Side; label: string; ts: string; text: string; partial: boolean }) {
  const agent = side === 'agent';
  const time = new Date(ts).toTimeString().slice(0, 8);
  return (
    <div className={`flex flex-col ${agent ? 'items-end' : 'items-start'}`}>
      <div className="mb-0.5 px-1 text-[10px] text-slate-500 dark:text-slate-400">
        <span className="font-semibold">{label}</span> · <span className="tabular-nums">{time}</span>
      </div>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-snug whitespace-pre-wrap ${
          agent
            ? 'rounded-br-sm bg-indigo-600 text-white'
            : 'rounded-bl-sm bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
        } ${partial ? 'italic opacity-70' : ''}`}
      >
        {text || '…'}
      </div>
    </div>
  );
}
