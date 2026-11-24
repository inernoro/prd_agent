/**
 * 考试上下文判据。删掉这几条，「没读也能考」就退回成一个说不清的漏洞。
 */
import { describe, expect, it } from 'vitest';
import { stanceOf, countsAsPassed, examEntryLabel } from '../examContext';

describe('考试上下文', () => {
  it('一本没读就交卷，算裸考', () => {
    expect(stanceOf(0, 11)).toBe('blind');
  });

  it('读了一部分算 partial，整卷读完才算 complete', () => {
    expect(stanceOf(3, 11)).toBe('partial');
    expect(stanceOf(11, 11)).toBe('complete');
  });

  it('脏数据不许把裸考算成读过（负数/NaN/缺字段一律按零本）', () => {
    expect(stanceOf(-1, 11)).toBe('blind');
    expect(stanceOf(Number.NaN, 11)).toBe('blind');
    expect(stanceOf(undefined as unknown as number, 11)).toBe('blind');
  });

  it('看板口径：裸考通过不计入通关', () => {
    expect(countsAsPassed(true, 0, 11)).toBe(false);
    expect(countsAsPassed(true, 1, 11)).toBe(true);
    expect(countsAsPassed(true, 11, 11)).toBe(true);
    expect(countsAsPassed(false, 11, 11)).toBe(false);
  });

  it('按钮文案跟着姿态走：没读是摸底，读过才叫结业考', () => {
    expect(examEntryLabel(0, 11, 7)).toContain('先摸个底');
    expect(examEntryLabel(0, 11, 7)).toContain('7 题');
    expect(examEntryLabel(2, 11, 7)).toContain('结业考');
  });
});
