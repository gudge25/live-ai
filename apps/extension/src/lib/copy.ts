import { formatTranscriptLine, type Side } from '@live-ai/shared';
import type { SessionView } from './reducer';

/** All final utterances of a session, chronologically, as `[time] Side: text` lines. */
export function transcriptText(session: SessionView, labels: Record<Side, string>): string {
  return session.items
    .filter((i) => !i.partial)
    .map((i, n) => ({ i, n }))
    .sort((a, b) => a.i.ts.localeCompare(b.i.ts) || a.n - b.n)
    .map(({ i }) => formatTranscriptLine(i, labels))
    .join('\n');
}
