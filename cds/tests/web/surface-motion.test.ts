import { describe, expect, it } from 'vitest';
import { isConsoleHref } from '../../web/src/components/layout/RouteMotion.js';
import { surfaceCamera, SURFACE_MOTION } from '../../web/src/lib/surfaceMotion.js';
import { investigationPrompt } from '../../web/src/pages/status/MonitorSampleEvidence.js';
import type { UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';
describe('共享镜头与调查事实', () => {
  it('沿用原稿几何，在视口内居中连续缩放，最大放大2.2而无垂直回弹', () => {
    const pose = surfaceCamera({ x: 200, y: 100, w: 200, h: 100 }, 1000, 500);
    expect(pose.zoom).toBe('translate(-360px,-180px) scale(2.2)');
    expect(pose.collapsed).toBe('translate(200px,100px) scale(0.2)');
    expect(SURFACE_MOTION).toMatchObject({ enter: 520, exit: 460 });
  });
  it('无效来源尺寸不产生Infinity或NaN', () => {
    expect(JSON.stringify(surfaceCamera({ x: 0, y: 0, w: 0, h: 0 }, 1000, 500))).not.toMatch(/Infinity|NaN/);
  });
  it('调查提示词含实例、环境与真实保留窗口，不复制秘密或伪造旧请求', () => {
    const target = { id: 'id', name: '订单检查', environmentLabel: '预发', intervalSeconds: 300, observeMode: 'active', probeUrl: 'https://secret.example/?token=do-not-copy' } as UptimeTargetSummary;
    const prompt = investigationPrompt(target, [{ t: 1_800_000_000_000, up: false, ms: 10, code: 200, exchange: { request: { method: 'GET', url: 'secret-url' }, note: 'not copied' } }], 'https://cds.example');
    expect(prompt).toContain('https://cds.example'); expect(prompt).toContain('预发'); expect(prompt).toContain('HTTP 200');
    expect(prompt).toContain('不代表固定20分钟'); expect(prompt).toContain('不可推测'); expect(prompt).not.toMatch(/do-not-copy|secret-url/);
  });
  it('已登记控制台路由可连续进入，登录、API、外站与未知入口保留原生行为', () => {
    expect(isConsoleHref('/branches/project-a')).toBe(true); expect(isConsoleHref('/cds-settings#activity')).toBe(true);
    for (const href of ['/login', '/api/healthz', 'https://external.example/status', '//external.example/status', '/unknown-route']) expect(isConsoleHref(href)).toBe(false);
  });

});
