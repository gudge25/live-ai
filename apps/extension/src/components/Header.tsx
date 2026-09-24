import { useEffect, useState } from 'react';
import { displayParty } from '../lib/party';
import type { SessionView } from '../lib/reducer';
import type { ConnectionState } from '../lib/socket';

const CONN_STYLE: Record<ConnectionState, { dot: string; label: string }> = {
  connecting: { dot: 'bg-amber-400', label: 'Connecting' },
  connected: { dot: 'bg-emerald-500', label: 'Connected' },
  reconnecting: { dot: 'bg-amber-400 animate-pulse', label: 'Reconnecting' },
  disconnected: { dot: 'bg-slate-400', label: 'Disconnected' },
  unauthorized: { dot: 'bg-rose-500', label: 'Unauthorized — check token' },
};

interface Props {
  conn: { state: ConnectionState; detail?: string };
  sessions: SessionView[];
  selected?: SessionView;
  onSelect: (id: string) => void;
  onSettings: () => void;
}

export function Header({ conn, sessions, selected, onSelect, onSettings }: Props) {
  const c = CONN_STYLE[conn.state];
  const info = selected?.info;
  const remote = info ? displayParty(info.remote) : null;

  return (
    <header className="border-b border-slate-200 dark:border-slate-800">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`size-2 shrink-0 rounded-full ${c.dot}`} title={conn.detail ?? c.label} />
        <div className="min-w-0 flex-1">
          {info ? (
            <>
              <div className="truncate text-sm font-semibold">{remote?.title}</div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span>ext {info.extension}</span>
                {remote?.subtitle && <span>· {remote.subtitle}</span>}
                <span>·</span>
                <Duration start={info.startedAt} end={info.endedAt} />
              </div>
            </>
          ) : (
            <div className="text-sm font-semibold">Live transcript</div>
          )}
        </div>
        <span className="text-[11px] text-slate-500 dark:text-slate-400">{conn.detail ?? c.label}</span>
        <button
          type="button"
          onClick={onSettings}
          title="Settings"
          className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          ⚙
        </button>
      </div>

      {sessions.length > 1 && (
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">
          {sessions.map((s) => (
            <button
              key={s.info.id}
              type="button"
              onClick={() => onSelect(s.info.id)}
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${
                s.info.id === selected?.info.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              {s.info.state === 'active' && <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-400" />}
              {s.info.extension} ↔ {displayParty(s.info.remote).title}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}

function Duration({ start, end }: { start: string; end?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (end) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [end]);
  const ms = Math.max(0, (end ? Date.parse(end) : now) - Date.parse(start));
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return <span className="tabular-nums">{mm}:{ss}</span>;
}
