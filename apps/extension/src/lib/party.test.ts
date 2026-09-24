import { describe, expect, it } from 'vitest';
import { displayParty } from './party';

describe('displayParty', () => {
  it('hides trunk routing noise in the name', () => {
    expect(displayParty({ name: '_8901#0048727830247', number: '0048727830247' })).toEqual({ title: '0048727830247' });
  });

  it('shows a real name with the number as subtitle', () => {
    expect(displayParty({ name: 'Bob Smith', number: '+447700900123' })).toEqual({ title: 'Bob Smith', subtitle: '+447700900123' });
  });

  it('does not repeat the number when name equals it', () => {
    expect(displayParty({ name: '+447700900123', number: '+447700900123' })).toEqual({ title: '+447700900123' });
  });

  it('ignores digit-only names', () => {
    expect(displayParty({ name: '8901', number: '0048727830247' })).toEqual({ title: '0048727830247' });
  });

  it('falls back to the name, then Unknown', () => {
    expect(displayParty({ name: 'Reception', number: '' })).toEqual({ title: 'Reception' });
    expect(displayParty({ name: '', number: '' })).toEqual({ title: 'Unknown' });
  });
});
