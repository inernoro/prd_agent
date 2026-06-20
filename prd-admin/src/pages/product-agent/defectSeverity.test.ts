import { describe, expect, it } from 'vitest';
import { normalizeTapdToSeverityLevel, readDefectSeverityLevel } from './defectSeverity';

describe('normalizeTapdToSeverityLevel', () => {
  it('maps TAPD 严重程度五档 to V2.6', () => {
    expect(normalizeTapdToSeverityLevel('紧急')).toBe('致命');
    expect(normalizeTapdToSeverityLevel('高')).toBe('严重');
    expect(normalizeTapdToSeverityLevel('中')).toBe('一般');
    expect(normalizeTapdToSeverityLevel('低')).toBe('轻微');
    expect(normalizeTapdToSeverityLevel('无关紧要')).toBe('轻微');
  });

  it('returns undefined for blank or unknown', () => {
    expect(normalizeTapdToSeverityLevel('P1')).toBeUndefined();
    expect(normalizeTapdToSeverityLevel('')).toBeUndefined();
  });
});

describe('readDefectSeverityLevel', () => {
  it('reads only V2.6 values from structuredData', () => {
    expect(readDefectSeverityLevel({ structuredData: { 严重程度: '严重' } })).toBe('严重');
    expect(readDefectSeverityLevel({ structuredData: { 严重程度: '高' } })).toBeNull();
  });
});
