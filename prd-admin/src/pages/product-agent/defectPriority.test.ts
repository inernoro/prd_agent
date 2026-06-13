import { describe, expect, it } from 'vitest';
import { normalizeTapdPriorityToGrade } from './defectPriority';

describe('normalizeTapdPriorityToGrade', () => {
  it('maps TAPD 优先级五档 to p0-p3', () => {
    expect(normalizeTapdPriorityToGrade('紧急')).toBe('p0');
    expect(normalizeTapdPriorityToGrade('高')).toBe('p1');
    expect(normalizeTapdPriorityToGrade('中')).toBe('p2');
    expect(normalizeTapdPriorityToGrade('低')).toBe('p3');
    expect(normalizeTapdPriorityToGrade('无关紧要')).toBe('p3');
  });

  it('maps P-level strings', () => {
    expect(normalizeTapdPriorityToGrade('P0')).toBe('p0');
    expect(normalizeTapdPriorityToGrade('P1')).toBe('p1');
    expect(normalizeTapdPriorityToGrade('p2')).toBe('p2');
    expect(normalizeTapdPriorityToGrade('P4')).toBe('p3');
  });

  it('returns undefined for blank or unknown', () => {
    expect(normalizeTapdPriorityToGrade('')).toBeUndefined();
    expect(normalizeTapdPriorityToGrade('未知')).toBeUndefined();
  });
});
