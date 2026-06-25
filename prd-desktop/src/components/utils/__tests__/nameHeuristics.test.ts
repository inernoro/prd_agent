import { describe, expect, it } from 'vitest';
import { sanitizeGroupName } from '../nameHeuristics';

describe('sanitizeGroupName', () => {
  it('strips html tags from imported group titles', () => {
    expect(sanitizeGroupName('<font style="color:rgb(15,17,21);">Part A 产品说明</font>')).toBe('Part A 产品说明');
  });

  it('decodes escaped html before stripping tags', () => {
    expect(sanitizeGroupName('&lt;font&gt;需求标题&lt;/font&gt;')).toBe('需求标题');
  });

  it('keeps ordinary angle-bracket text that is not an html tag', () => {
    expect(sanitizeGroupName('A < B 需求')).toBe('A < B 需求');
  });
});
