import type { Side, Utterance } from '@live-ai/shared';

const LABELS: Record<Side, string> = { agent: 'Agent', caller: 'Caller' };

/**
 * Formats final utterances for the LLM Gateway prompt: chronological,
 * side-tagged, no timestamps (unlike `formatTranscriptLine`, which keeps
 * them for clipboard export).
 */
export function formatSummaryTranscript(utterances: Utterance[]): string {
  return utterances
    .map((u, n) => ({ u, n }))
    .sort((a, b) => a.u.ts.localeCompare(b.u.ts) || a.n - b.n)
    .map(({ u }) => `${LABELS[u.side]}: ${u.text}`)
    .join('\n');
}
