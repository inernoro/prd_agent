/*
 * Codex PR #1543 第五轮（afacb01a 上）——后端两条各配一条会红的判据：
 *   1. 旧 MAP 通道换凭据 / 清凭据之后，之前的投递记录不能继续证明新目的地通着；
 *   2. 对账结果带 projectId，同一个 URL 被两个项目各登记一次时各认各的（路由用例在 tests/routes）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AlarmChannel } from '../../src/services/alarm-channel.js';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const codeOf = (src: string): string => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

describe('P1 旧 MAP 通道换凭据后投递证明作废', () => {
  it('演练成功 → healthy；reset 之后回到 untested，计数归零', () => {
    const ch = new AlarmChannel(() => true, 'MAP 站内通知');
    ch.record({ ok: true, status: 200 }, 'drill', 1000);
    expect(ch.snapshot()).toMatchObject({ status: 'healthy', delivered: 1 });
    ch.reset();
    expect(ch.snapshot()).toMatchObject({ status: 'untested', delivered: 0, failed: 0 });
    expect(ch.snapshot().last).toBeUndefined();
  });

  it('index.ts 的 writeAlarmNotify 写完凭据就 reset 旧通道的台账（清凭据同样）', () => {
    const index = codeOf(read('../../src/index.ts'));
    expect(index).toMatch(/writeAlarmNotify: \(next\) => \{\s*stateService\.setAlarmNotify\(next\);\s*alarmChannel\.reset\(\);/);
  });
});

describe('P2 对账结果带 projectId', () => {
  it('发现器每条结果都盖上 project.id，路由按项目 + 地址一起筛', () => {
    const runner = codeOf(read('../../src/services/monitor-discovery-runner.ts'));
    expect(runner).toMatch(/endpoints\.push\(\{\s*projectId: project\.id,\s*url,/);
    const routes = codeOf(read('../../src/routes/uptime.ts'));
    expect(routes).toContain('run.endpoints.filter((o) => o.projectId === projectId && mine.has(o.url))');
  });
});
