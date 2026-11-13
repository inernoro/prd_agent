// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportDeliverySnapshot } from '@/services/contracts/reportEvidence';
import { ReportDeliveryEvidencePanel } from './ReportDeliveryEvidencePanel';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function snapshot(): ReportDeliverySnapshot {
  return {
    schemaVersion: 1, periodStart: '2026-10-01T00:00:00+08:00', periodEnd: '2026-10-31T23:59:59+08:00', timeZone: 'Asia/Shanghai',
    headline: '交付依据不足，仍有一项外部阻塞。', limitations: ['历史来源尚不完整，不能确认新增成果数量。'],
    items: [{ id: 'delivery-a', title: '同一导出功能', movement: '延续推进', previousSummary: '功能完成，验证未完成',
      codeStatus: 'complete', codeLabel: '功能完成（需求方确认）', validationStatus: 'failed', validationLabel: '验证失败（仍待复验）',
      releaseStatus: 'unknown', releaseLabel: '上线未证实', blockReason: '供应商未提供联调账号', nextStep: '等待供应商开通账号后复验',
      sources: [{ id: 'source-a', uri: 'https://example.com/verification/1', excerpt: '导出测试失败，尚未发布', occurredAt: '2026-10-12T10:00:00+08:00', kind: 'validation_failed', revision: 'abc123' }] }],
    metrics: [{ key: 'efficiency', label: '效率变化', available: false, text: '缺少同口径测量，不推算提升比例。', sources: [] }],
  };
}

describe('交付事实只读展示', () => {
  it('按后端标签分别展示功能、验证和上线，不把完成状态扩展到其他阶段', () => {
    act(() => root.render(<ReportDeliveryEvidencePanel evidence={snapshot()} />));
    expect(container.textContent).toContain('功能完成（需求方确认）');
    expect(container.textContent).toContain('验证失败（仍待复验）');
    expect(container.textContent).toContain('上线未证实');
    expect(container.textContent).toContain('供应商未提供联调账号');
    expect(container.textContent).toContain('等待供应商开通账号后复验');
    expect(container.textContent).toContain('缺少同口径测量，不推算提升比例。');
    expect(container.querySelector('a')?.href).toBe('https://example.com/verification/1');
    expect(container.querySelectorAll('input,textarea,button,form')).toHaveLength(0);
  });

  it('未知状态仍显示后端解释；没有来源不补造链接或个人评价', () => {
    const data = snapshot();
    data.items[0].releaseStatus = 'future-state'; data.items[0].releaseLabel = '后端待核查'; data.items[0].sources = [];
    act(() => root.render(<ReportDeliveryEvidencePanel evidence={data} />));
    expect(container.textContent).toContain('后端待核查');
    expect(container.textContent).toContain('未附可核查来源');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-report-section]')).toBeNull();
  });
  it('历史报告缺少事项快照时保留原文并说明阶段与指标尚未核查，不否定已有来源引用', () => {
    act(() => root.render(<><ReportDeliveryEvidencePanel /><p>按计划推进，无阻塞。</p><a href="https://example.com/old-source">旧来源引用</a></>));
    const note = container.querySelector('[role="note"]');
    expect(note?.textContent).toBe('这份历史报告未保存事项级来源快照；正文保留原文，功能、验证、上线及指标尚未核查。');
    expect(container.textContent).toContain('按计划推进，无阻塞。');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/old-source');
    expect(container.querySelector('dl')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

});
