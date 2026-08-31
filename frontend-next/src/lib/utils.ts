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
