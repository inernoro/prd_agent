// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportDeliverySnapshot } from '@/services/contracts/reportEvidence';
import { DailyDeliveryEvidencePanel } from './DailyDeliveryEvidencePanel';

const getEvidence = vi.hoisted(() => vi.fn());
vi.mock('@/services', () => ({ getMyDailyDeliveryEvidence: getEvidence }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>核对中</span> }));
let container: HTMLDivElement;
let root: Root;
const snapshot = (date: string): ReportDeliverySnapshot => ({ schemaVersion: 1, periodStart: date, periodEnd: date, timeZone: 'Asia/Shanghai', headline: `${date} 的实际记录`, items: [], limitations: ['来源不足，不推算交付数量'], metrics: [] });
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); getEvidence.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('实际日常记录入口的交付事实', () => {
  it('读取失败清楚提示并允许重试，成功只显示所选日后端快照', async () => {
    getEvidence.mockResolvedValueOnce({ success: false, error: { message: '来源暂不可用' } }).mockResolvedValueOnce({ success: true, data: snapshot('2026-11-13') });
    await act(async () => { root.render(<DailyDeliveryEvidencePanel date="2026-11-13" />); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('来源暂不可用');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(getEvidence).toHaveBeenLastCalledWith({ date: '2026-11-13' });
    expect(container.textContent).toContain('本日交付事实');
    expect(container.textContent).toContain('2026-11-13 的实际记录');
    expect(container.querySelector('input,textarea,form')).toBeNull();
  });
  it('切换日期后旧请求即使更晚返回，也不能覆盖新日期事实', async () => {
    let finishOld!: (result: { success: true; data: ReportDeliverySnapshot }) => void;
    getEvidence.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce({ success: true, data: snapshot('2026-11-14') });
    await act(async () => { root.render(<DailyDeliveryEvidencePanel date="2026-11-13" />); });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { root.render(<DailyDeliveryEvidencePanel date="2026-11-14" />); });
    await act(async () => finishOld({ success: true, data: snapshot('2026-11-13') }));
    expect(container.textContent).toContain('2026-11-14 的实际记录');
    expect(container.textContent).not.toContain('2026-11-13 的实际记录');
  });
});
