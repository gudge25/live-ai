import type { Party } from '@live-ai/shared';

/**
 * What to show for the remote party. Trunks often put routing noise into the
 * CallerID name (e.g. `_8901#0048727830247`), so the name is only used when it
 * looks like a real name: it has letters, no `#` routing marker, and does not
 * just repeat the number.
 */
export function displayParty(p: Party): { title: string; subtitle?: string } {
  const name = p.name.trim();
  const number = p.number.trim();
  const nameUsable = /\p{L}/u.test(name) && !name.includes('#') && !(number && name.includes(number));
  if (nameUsable) return number ? { title: name, subtitle: number } : { title: name };
  return { title: number || name || 'Unknown' };
}
