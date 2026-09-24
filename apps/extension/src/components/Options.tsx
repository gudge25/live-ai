import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, buildSocketUrl, type Settings } from '../lib/settings';
import { loadSettings, saveSettings } from '../lib/settings-store';
import { openSidePanel, openTranscriptWindow } from '../lib/windows';

const FIELDS: { key: keyof Settings; label: string; hint?: string; type?: string }[] = [
  { key: 'serverUrl', label: 'Server URL', hint: 'Backend WebSocket endpoint, e.g. ws://localhost:8765/ui or wss://live-ai.example.com/ui' },
  { key: 'token', label: 'Access token', hint: 'UI_TOKEN from the server .env', type: 'password' },
  { key: 'extensions', label: 'Extensions', hint: 'Comma-separated, e.g. 222,223. Empty = all monitored extensions.' },
  { key: 'agentLabel', label: 'Agent label' },
  { key: 'callerLabel', label: 'Caller label' },
];

export function Options() {
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings().then(setForm);
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      buildSocketUrl(form);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setError(null);
    await saveSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="min-h-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <form onSubmit={save} className="mx-auto max-w-lg space-y-4 px-6 py-8">
        <h1 className="text-lg font-semibold">Live AI Transcript — Settings</h1>
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="text-sm font-medium">{f.label}</span>
            <input
              type={f.type ?? 'text'}
              value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900"
            />
            {f.hint && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{f.hint}</span>}
          </label>
        ))}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => void openTranscriptWindow()}
            className="rounded-md border border-indigo-600 px-4 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950"
          >
            Open transcript window ↗
          </button>
          <button
            type="button"
            onClick={() => void openSidePanel()}
            className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Open side panel
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Tip: pin the extension (🧩 → 📌) — clicking its icon opens the side panel.
        </p>
      </form>
    </div>
  );
}
