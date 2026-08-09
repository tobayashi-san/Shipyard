import { describe, expect, it } from 'vitest';
import { asArray } from './utils';

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
