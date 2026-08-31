import { describe, expect, it } from 'vitest';
import { asArray, DISPLAY_TIME_ZONE, formatDateTime } from './utils';

describe('asArray', () => {
  it('preserves valid collections', () => {
    expect(asArray<string>(['one', 'two'])).toEqual(['one', 'two']);
  });

  it('turns stale object responses into a safe empty collection', () => {
    expect(asArray({ error: 'legacy response' })).toEqual([]);
  });

  it('turns nullish and scalar values into a safe empty collection', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray('unexpected')).toEqual([]);
  });
});

describe('formatDateTime', () => {
  it('uses the shared Europe/Zurich display timezone', () => {
    expect(DISPLAY_TIME_ZONE).toBe('Europe/Zurich');
    const formatted = formatDateTime('2026-01-15T12:30:00.000Z');
    expect(formatted).toContain('15 Jan 2026');
    expect(formatted).toContain('13:30');
  });

  it('returns a dash for missing or invalid values', () => {
    expect(formatDateTime()).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});
