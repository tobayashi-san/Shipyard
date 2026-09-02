import { describe, expect, it } from 'vitest';
import {
  asArray,
  DISPLAY_TIME_ZONE,
  formatDateInput,
  formatDateTime,
  formatZonedDateTimeInput,
  parseDateInput,
  parseZonedDateTimeInput,
} from './utils';

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

  it('renders maintenance timestamps unambiguously with a 24-hour clock', () => {
    const formatted = formatDateTime('2026-09-02T17:30:00.000Z');
    expect(formatted).toMatch(/^2 Sept? 2026, 19:30$/);
    expect(formatted).not.toMatch(/AM|PM/i);
  });

  it('returns a dash for missing or invalid values', () => {
    expect(formatDateTime()).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('deterministic date inputs', () => {
  it('round-trips en-GB calendar dates', () => {
    expect(formatDateInput('2026-09-02')).toBe('02/09/2026');
    expect(parseDateInput('2/9/2026')).toBe('2026-09-02');
    expect(parseDateInput('31/02/2026')).toBeNull();
  });

  it('round-trips 24-hour wall times in the selected timezone', () => {
    const instant = parseZonedDateTimeInput('02/09/2026, 21:23', 'Europe/Zurich');
    expect(instant).toBe('2026-09-02T19:23:00.000Z');
    expect(formatZonedDateTimeInput(instant, 'Europe/Zurich')).toBe('02/09/2026, 21:23');
    expect(formatZonedDateTimeInput(instant, 'UTC')).toBe('02/09/2026, 19:23');
  });

  it('rejects ambiguous browser-style and nonexistent wall times', () => {
    expect(parseDateInput('09/02/2026, 07:30 PM')).toBeNull();
    expect(parseZonedDateTimeInput('29/03/2026, 02:30', 'Europe/Zurich')).toBeNull();
  });
});
