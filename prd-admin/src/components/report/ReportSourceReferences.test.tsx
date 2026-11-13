// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportSourceReferences } from './ReportSourceReferences';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('报告来源核查', () => {
  it('保留原条目编号，只有明确 URL 可点击，其他来源 ID 原样展示', () => {
    act(() => root.render(<ReportSourceReferences items={[{}, { sourceRef: 'https://github.com/example/repo/commit/abc' }, { sourceRef: 'task:123' }]} />));
    expect(container.textContent).toContain('核查来源（2）');
    expect(container.textContent).toContain('条目 2');
    expect(container.textContent).toContain('task:123');
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://github.com/example/repo/commit/abc');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('允许后端给出的同站报告深链，保留原路径', () => {
    act(() => root.render(<ReportSourceReferences items={[{ sourceRef: '/report-agent/report/report-a' }]} />));
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/report-agent/report/report-a');
  });

  it('不执行可疑引用，也不把无来源的旧条目伪装成可核查结论', () => {
    act(() => root.render(<ReportSourceReferences items={[{ sourceRef: 'javascript:alert(1)' }, { sourceRef: '<script>alert(1)</script>' }, { sourceRef: '//untrusted.example/path' }, { sourceRef: '/\\untrusted.example/path' }]} />));
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    act(() => root.render(<ReportSourceReferences items={[{ sourceRef: ' ' }, {}]} />));
    expect(container.childElementCount).toBe(0);
  });
});
