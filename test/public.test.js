import { describe, it, expect } from 'vitest';
import { validateMessage, COMMITTEE, AMENITIES, MAX_MESSAGE } from '../functions/lib/public.js';

describe('contact messages', () => {
  const good = { name: 'Priya Menon', body: 'The pool gate is sticking.' };

  it('accepts a plain message', () => {
    const r = validateMessage(good);
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Priya Menon');
  });

  it('requires a name and a message', () => {
    expect(validateMessage({ ...good, name: '  ' }).ok).toBe(false);
    expect(validateMessage({ ...good, body: '' }).ok).toBe(false);
  });

  it('caps the length', () => {
    expect(validateMessage({ ...good, body: 'x'.repeat(MAX_MESSAGE + 1) }).ok).toBe(false);
  });

  it('treats email as optional but checks it when given', () => {
    expect(validateMessage({ ...good, email: '' }).value.email).toBe(null);
    expect(validateMessage({ ...good, email: 'priya@example.com' }).ok).toBe(true);
    expect(validateMessage({ ...good, email: 'priya@@example' }).ok).toBe(false);
  });

  it('trims whitespace rather than storing it', () => {
    expect(validateMessage({ name: '  Priya  ', body: '  hello  ' }).value)
      .toMatchObject({ name: 'Priya', body: 'hello' });
  });

  it('normalises a blank phone to null', () => {
    expect(validateMessage({ ...good, phone: '   ' }).value.phone).toBe(null);
  });
});

describe('what the public page exposes', () => {
  it('publishes the committee deliberately, not by reading the resident list', () => {
    // The list is hard-coded so that adding a resident can never silently
    // publish their name and flat on an indexable page.
    expect(COMMITTEE.map((c) => c.role)).toEqual(
      ['President', 'Secretary', 'Treasurer', 'Gas In-charge']);
  });

  it('gives a contact number only for the treasurer', () => {
    const withPhone = COMMITTEE.filter((c) => c.phone);
    expect(withPhone).toHaveLength(1);
    expect(withPhone[0].role).toBe('Treasurer');
  });

  it('lists the amenities the building actually has', () => {
    expect(AMENITIES).toContain('Swimming pool');
    expect(AMENITIES.length).toBeGreaterThan(4);
  });
});
