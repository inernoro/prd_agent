import { describe, expect, it } from 'vitest';
import { clearDefectDeepLinkParams, getDefectDeepLinkId } from '../defectDeepLink';

describe('defect deep link helpers', () => {
  it('reads canonical and legacy defect id params', () => {
    expect(getDefectDeepLinkId(new URLSearchParams('defectId=d1'))).toBe('d1');
    expect(getDefectDeepLinkId(new URLSearchParams('id=d2'))).toBe('d2');
    expect(getDefectDeepLinkId(new URLSearchParams('defectId=d1&id=d2'))).toBe('d1');
  });

  it('clears defect id params without dropping unrelated query state', () => {
    const next = clearDefectDeepLinkParams(new URLSearchParams('tab=open&id=d2&defectId=d1'));

    expect(next.get('defectId')).toBeNull();
    expect(next.get('id')).toBeNull();
    expect(next.get('tab')).toBe('open');
  });
});
