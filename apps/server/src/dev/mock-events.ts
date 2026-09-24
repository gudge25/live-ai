/**
 * Serves the /ui protocol with a fake call so the extension can be developed without a PBX.
 *   pnpm dev:mock-events   ->  ws://localhost:8765/ui?token=$UI_TOKEN (default "dev-token-0123456789")
 */
import type { SessionInfo, Side } from '@live-ai/shared';
import { SessionStore } from '../hub/session-store.js';
import { UiServer } from '../hub/ui-server.js';
import { createLogger } from '../logger.js';

const log = createLogger('info');
const token = process.env.UI_TOKEN || 'dev-token-0123456789';
const port = Number(process.env.UI_PORT || 8765);
const store = new SessionStore(10);
const ui = new UiServer({ token, store, log, ariStatus: () => 'connected' });

const script: [Side, string][] = [
  ['caller', "Hi, I'm calling about my order from last week."],
  ['agent', 'Sure, I can help with that. Could you give me the order number?'],
  ['caller', "It's four five seven two one."],
  ['agent', 'Thanks. I can see it was shipped yesterday and should arrive tomorrow.'],
  ['caller', 'Great, that is all I needed. Thank you!'],
  ['agent', "You're welcome, have a nice day."],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCall(n: number) {
  const info: SessionInfo = {
    id: `mock${n}`,
    extension: '222',
    channelId: `mock.${n}`,
    remote: { name: 'Test Caller', number: '+447700900123' },
    startedAt: new Date().toISOString(),
    state: 'active',
  };
  store.add(info);
  ui.broadcast({ type: 'session_started', session: info }, info.extension);
  const turns: Record<Side, number> = { agent: 0, caller: 0 };
  for (const [side, sentence] of script) {
    const turn = turns[side]++;
    const words = sentence.split(' ');
    for (let i = 1; i <= words.length; i++) {
      const text = words.slice(0, i).join(' ').toLowerCase().replace(/[.,!?]/g, '');
      ui.broadcast({ type: 'partial', sessionId: info.id, side, turn, text, ts: new Date().toISOString() }, info.extension);
      await sleep(180);
    }
    const u = { sessionId: info.id, side, turn, text: sentence, ts: new Date().toISOString() };
    store.addFinal(u);
    ui.broadcast({ type: 'final', ...u }, info.extension);
    await sleep(700);
  }
  const endedAt = new Date().toISOString();
  store.update(info.id, { state: 'ended', endedAt });
  ui.broadcast({ type: 'session_ended', sessionId: info.id, endedAt, state: 'ended' }, info.extension);
}

await ui.listen(port, '127.0.0.1');
log.info(`mock events on ws://localhost:${port}/ui?token=${token}`);
for (let n = 1; ; n++) {
  await runCall(n);
  await sleep(5000);
}
