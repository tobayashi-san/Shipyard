export interface AuditDetailField {
  key: string;
  label: string;
  value: string;
}

export function normalizeAuditIp(value?: string | null): string {
  const raw = String(value || '').trim();
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (!mapped) return raw;
  const octets = mapped[1].split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? mapped[1]
    : raw;
}

function auditFieldLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (letter) => letter.toUpperCase())
    .replace(/\bId\b/g, 'ID');
}

export function parseAuditDetail(detail?: string | null): {
  summary: string;
  fields: AuditDetailField[];
  raw: string;
} {
  const raw = String(detail || '').trim();
  const fields: AuditDetailField[] = [];
  const remainder: string[] = [];
  const pattern = /([A-Za-z][\w.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let cursor = 0;
  for (const match of raw.matchAll(pattern)) {
    const index = match.index || 0;
    const text = raw.slice(cursor, index).trim();
    if (text) remainder.push(text);
    fields.push({
      key: match[1],
      label: auditFieldLabel(match[1]),
      value: match[2] ?? match[3] ?? match[4] ?? '',
    });
    cursor = index + match[0].length;
  }
  const tail = raw.slice(cursor).trim();
  if (tail) remainder.push(tail);
  return { summary: remainder.join(' ').trim(), fields, raw };
}
