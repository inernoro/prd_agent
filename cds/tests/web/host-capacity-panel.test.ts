import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HostCapacityView } from '../../web/src/pages/cds-settings/components/HostCapacityPanel';
it('冷启动与读取失败明确未知，不能显示安全或零增长', () => {
  for (const reason of ['尚未收到可信容量采样', '容量观测读取失败']) {
    const text = renderToStaticMarkup(createElement(HostCapacityView, { observation: { status: 'unknown', sampledAt: null, reason } }));
    expect(text).toContain('当前容量风险未知'); expect(text).toContain(reason);
    expect(text).not.toContain('本次增长与余量检查正常'); expect(text).not.toContain('0.00 GiB');
    expect(text).toContain('不代表回收任务已成功');
  }
});
it('页面呈现可核对来源、负变化及安全余量预测，不累加共享占用', () => {
  const text = renderToStaticMarkup(createElement(HostCapacityView, { observation: { status: 'warning', sampledAt: '2026-11-16T08:00:00Z', report: {
    version: 1, host: 'isolated-host', at: 1794816000, status: 'warning', alerts: [],
    sources: { cache: { path: '/isolated/cache', device: '1', bytes: 21474836480, deltaBytes: -1073741824, bytesPerDay: 10737418240, windowSeconds: 86400 } },
    filesystems: { '1': { totalBytes: 107374182400, usedBytes: 64424509440, availableBytes: 42949672960, totalInodes: 1000, availableInodes: 900,
      usedPercent: 60, inodeUsedPercent: 10, deltaBytes: 10737418240, bytesPerDay: 10737418240, windowSeconds: 86400, daysToFull: 4, daysToReserve: 3.4 } },
    policy: { warningPercent: 75, criticalPercent: 90, reserveBytes: 6442450944, horizonDays: 7, maxSamples: 192 },
  } } }));
  for (const expected of ['20.00 GiB', '-1.00 GiB', '10.00 GiB / 天', '60.0', '3.4 天', '6.00 GiB', '不能相加']) expect(text).toContain(expected);
});
