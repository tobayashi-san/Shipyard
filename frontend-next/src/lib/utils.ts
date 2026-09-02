import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Safely narrows untrusted API data to an array.
 *
 * A surprising number of older installations can return an object for a
 * collection endpoint after a failed migration.  `value ?? []` does not
 * protect against that shape, while this helper does.
 */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export const DISPLAY_TIME_ZONE = 'Europe/Zurich';

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
};

function validDateParts({ year, month, day }: DateParts): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function zonedDateParts(value: string | number | Date, timeZone: string): Required<DateParts> | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    const result = {
      year: part('year'),
      month: part('month'),
      day: part('day'),
      hour: part('hour'),
      minute: part('minute'),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

/** Keeps operator-facing timestamps consistent regardless of browser locale. */
export function formatDateTime(
  value: string | number | Date | null | undefined = null,
  options: Intl.DateTimeFormatOptions = {},
): string {
  if (value == null || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DISPLAY_TIME_ZONE,
    ...options,
  }).format(date);
}

/** Formats the API's YYYY-MM-DD date value without involving browser locale UI. */
export function formatDateInput(value: string | null | undefined): string {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const [, year, month, day] = match;
  if (!validDateParts({ year: Number(year), month: Number(month), day: Number(day) })) return '';
  return `${day}/${month}/${year}`;
}

/** Parses a deterministic en-GB date input into the API's YYYY-MM-DD form. */
export function parseDateInput(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const parts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
  };
  if (!validDateParts(parts)) return null;
  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}`;
}

/** Formats an instant as a deterministic en-GB wall time in the selected zone. */
export function formatZonedDateTimeInput(
  value: string | number | Date | null | undefined,
  timeZone: string,
): string {
  if (value == null || value === '') return '';
  const parts = zonedDateParts(value, timeZone);
  if (!parts) return '';
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}, ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** Resolves a selected-zone wall time to an ISO instant, rejecting invalid DST times. */
export function parseZonedDateTimeInput(value: string, timeZone: string): string | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText, hourText, minuteText] = match;
  const desired: Required<DateParts> = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  if (!validDateParts(desired) || desired.hour > 23 || desired.minute > 59) return null;

  const desiredAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateParts(candidate, timeZone);
    if (!actual) return null;
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    candidate += desiredAsUtc - actualAsUtc;
  }
  const resolved = zonedDateParts(candidate, timeZone);
  if (!resolved || Object.keys(desired).some(
    (key) => resolved[key as keyof Required<DateParts>] !== desired[key as keyof Required<DateParts>],
  )) return null;
  return new Date(candidate).toISOString();
}
