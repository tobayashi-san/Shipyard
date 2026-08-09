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
