export interface IntervalDef { value: string; labelKey: string; needsTime: boolean; needsWeekday: boolean; needsMonthday: boolean }

export const INTERVALS: IntervalDef[] = [
  { value: 'daily', labelKey: 'sc.daily', needsTime: true, needsWeekday: false, needsMonthday: false },
  { value: 'weekly', labelKey: 'sc.weekly', needsTime: true, needsWeekday: true, needsMonthday: false },
  { value: 'monthly', labelKey: 'sc.monthly', needsTime: true, needsWeekday: false, needsMonthday: true },
  { value: 'every_6h', labelKey: 'sc.every6h', needsTime: false, needsWeekday: false, needsMonthday: false },
  { value: 'every_12h', labelKey: 'sc.every12h', needsTime: false, needsWeekday: false, needsMonthday: false },
];

export const WEEKDAYS = [
  { value: 1, labelKey: 'sc.mon' }, { value: 2, labelKey: 'sc.tue' }, { value: 3, labelKey: 'sc.wed' },
  { value: 4, labelKey: 'sc.thu' }, { value: 5, labelKey: 'sc.fri' }, { value: 6, labelKey: 'sc.sat' },
  { value: 0, labelKey: 'sc.sun' },
];

const COLLAPSED_KEY = 'shipyard.ui.playbooks.collapsedCategories';

export const TEMPLATE_YAML = `---
- name: My New Playbook
  hosts: all
  become: yes
  tasks:
    - name: Ping all hosts
      ping:
`;

export function buildAllExceptTargets(excluded: string[]): string {
  const unique = [...new Set(excluded.map(name => String(name || '').trim()).filter(Boolean))];
  return unique.length === 0 ? 'all' : `all:${unique.map(name => `!${name}`).join(':')}`;
}

export function parsePlaybookTargets(targets: string) {
  const raw = String(targets || '').trim();
  if (!raw || raw === 'all') return { mode: 'all' as const, excluded: [] as string[], included: [] as string[] };
  const parts = raw.split(':').map(target => target.trim()).filter(Boolean);
  if (parts[0] === 'all' && parts.slice(1).every(target => target.startsWith('!') && target.length > 1)) {
    return { mode: 'all' as const, excluded: parts.slice(1).map(target => target.slice(1)), included: [] as string[] };
  }
  return { mode: 'list' as const, excluded: [] as string[], included: raw.split(',').map(target => target.trim()).filter(Boolean) };
}

export function cronToSelectors(cron: string) {
  if (cron === '0 */6 * * *') return { interval: 'every_6h', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  if (cron === '0 */12 * * *') return { interval: 'every_12h', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const monthly = cron.match(/^(\d+) (\d+) (\d+) \* \*$/);
  if (monthly) return { interval: 'monthly', minute: +monthly[1], hour: +monthly[2], weekday: 1, monthday: +monthly[3] };
  const daily = cron.match(/^(\d+) (\d+) \* \* \*$/);
  if (daily) return { interval: 'daily', minute: +daily[1], hour: +daily[2], weekday: 1, monthday: 1 };
  const weekly = cron.match(/^(\d+) (\d+) \* \* (\d+)$/);
  if (weekly) return { interval: 'weekly', minute: +weekly[1], hour: +weekly[2], weekday: +weekly[3], monthday: 1 };
  return { interval: 'daily', hour: 3, minute: 0, weekday: 1, monthday: 1 };
}

export function selectorsToCron(interval: string, hour: number, minute: number, weekday: number, monthday: number) {
  switch (interval) {
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekly': return `${minute} ${hour} * * ${weekday}`;
    case 'monthly': return `${minute} ${hour} ${monthday} * *`;
    case 'every_6h': return `${minute} */6 * * *`;
    case 'every_12h': return `${minute} */12 * * *`;
    default: return `${minute} ${hour} * * *`;
  }
}

export function formatDate(date?: string) {
  if (!date) return '';
  try { return new Date(date).toLocaleString(); } catch { return date; }
}

export function loadCollapsedCategories(): Set<string> {
  try { const raw = localStorage.getItem(COLLAPSED_KEY); const values = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(values) ? values.filter((value: unknown) => typeof value === 'string') : []); } catch { return new Set(); }
}

export function saveCollapsedCategories(categories: Set<string>) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...categories])); } catch { /* unavailable storage */ }
}
