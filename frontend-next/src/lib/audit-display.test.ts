import { describe, expect, it } from 'vitest';
import { normalizeAuditIp, parseAuditDetail } from './audit-display';

describe('normalizeAuditIp', () => {
  it('shows IPv4-mapped addresses as IPv4 while rejecting invalid octets', () => {
    expect(normalizeAuditIp('::ffff:10.77.25.1')).toBe('10.77.25.1');
    expect(normalizeAuditIp('::ffff:999.77.25.1')).toBe('::ffff:999.77.25.1');
    expect(normalizeAuditIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('parseAuditDetail', () => {
  it('separates technical key-value data into named fields', () => {
    expect(parseAuditDetail('Updated agent version=3.0.8 path="/opt/ship yard"')).toEqual({
      summary: 'Updated agent',
      fields: [
        { key: 'version', label: 'Version', value: '3.0.8' },
        { key: 'path', label: 'Path', value: '/opt/ship yard' },
      ],
      raw: 'Updated agent version=3.0.8 path="/opt/ship yard"',
    });
  });
});
