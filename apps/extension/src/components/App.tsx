import { useEffect, useReducer, useState } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, parseExtensions, type Settings } from '../lib/settings';
import { loadSettings, watchSettings } from '../lib/settings-store';
import { openTranscriptWindow } from '../lib/windows';
import { initialState, reducer } from '../lib/reducer';
import { TranscriptSocket, type ConnectionState } from '../lib/socket';
import { transcriptText } from '../lib/copy';
import { Header } from './Header';
import { Dialog } from './Dialog';

export type AppMode = 'sidepanel' | 'popout';

export function App({ mode }: { mode: AppMode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [conn, setConn] = useState<{ state: ConnectionState; detail?: string }>({ state: 'connecting' });
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadSettings().then(setSettings);
    return watchSettings(setSettings);
  }, []);

  useEffect(() => {
    if (!settings) return;
    dispatch({ type: 'setFilter', extensions: parseExtensions(settings.extensions) });
    const socket = new TranscriptSocket(settings, {
      onEvent: (event) => dispatch({ type: 'event', event }),
      onState: (s, detail) => setConn({ state: s, detail }),
    });
    socket.start();
    return () => socket.stop();
  }, [settings]);

  const s = settings ?? DEFAULT_SETTINGS;
  const labels = { agent: s.agentLabel, caller: s.callerLabel };
  const session = state.selectedId ? state.sessions[state.selectedId] : undefined;
  const sessions = state.order.map((id) => state.sessions[id]!);

  const copy = async () => {
    if (!session) return;
    await navigator.clipboard.writeText(transcriptText(session, labels));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const popOut = () => void openTranscriptWindow();

  return (
    <div className="flex h-full flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header
        conn={conn}
        sessions={sessions}
        selected={session}
        onSelect={(id) => dispatch({ type: 'select', id })}
        onSettings={() => void browser.runtime.openOptionsPage()}
      />

      {session ? (
        <Dialog key={session.info.id} session={session} labels={labels} />
      ) : (
        <EmptyState conn={conn.state} extensions={parseExtensions(s.extensions)} hasToken={!!s.token} />
      )}

      <footer className="flex items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
        <ToolbarButton onClick={copy} disabled={!session?.items.some((i) => !i.partial)}>
          {copied ? 'Copied ✓' : 'Copy'}
        </ToolbarButton>
        {session && session.info.state !== 'active' && (
          <ToolbarButton onClick={() => dispatch({ type: 'clear', id: session.info.id })}>Clear</ToolbarButton>
        )}
        <div className="flex-1" />
        {mode === 'sidepanel' && (
          <ToolbarButton onClick={popOut} title="Open in a floating window">
            Pop out ↗
          </ToolbarButton>
        )}
      </footer>
    </div>
  );
}

function ToolbarButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    />
  );
}

function EmptyState({ conn, extensions, hasToken }: { conn: ConnectionState; extensions: string[]; hasToken: boolean }) {
  const target = extensions.length ? extensions.join(', ') : 'any extension';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-3xl">🎧</div>
      <p className="text-sm font-medium">
        {conn === 'connected' ? `Waiting for a call on ${target}…` : 'Not connected to the server'}
      </p>
      {!hasToken && (
        <p className="text-xs text-slate-500 dark:text-slate-400">Set the server URL and access token in Settings.</p>
      )}
    </div>
  );
}
