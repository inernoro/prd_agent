/*
 * 接线守卫：通知通道的三根线，删掉任何一根都不会有测试变红。
 *
 * predicate-and-wiring-discipline 形状 2（链路只建一半）：
 * AlarmChannel 可以造得很好、单测全绿，但只要没人调 record()，
 * 面板上那句「铃通不通」就永远停在「没发过」；只要摘掉 summary 里的 alarm 字段，
 * 前端就退回「状态未知」。两种退化都**不报错、不变红**，只是静默失效。
 *
 * 这条守卫刻意不断言任何文案，只断言「线接着」。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/**
 * 去掉注释，免得注释里提到的写法把扫描带偏。
 *
 * 块注释**必须要求它独占一行的开头**：源码里的 `'/api/*'` 这种字符串含有 `/*`，
 * 裸的非贪婪 `\/\*[\s\S]*?\*\/` 会从那里一路吃到下一个 `*\/`，把中间几百行真代码
 * 一起吞掉——第一版就是这么把 `new AlarmChannel(` 扫没了，判据看着在跑、其实在空扫。
 */
const codeOf = (src: string): string =>
  src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\{\/\*[\s\S]*?\*\/\}/gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('通知通道的接线一根都不能少', () => {
  const index = codeOf(read('../../src/index.ts'));
  const uptime = codeOf(read('../../src/routes/uptime.ts'));
  const board = codeOf(read('../../web/src/pages/status/OwnerBoard.tsx'));
  const page = codeOf(read('../../web/src/pages/StatusPage.tsx'));

  it('真告警的投递结果要记账——成功与失败两条路都要记', () => {
    expect(index).toContain('new AlarmChannel(');
    // configured 必须是取值函数：传布尔快照会让「刚配好」和「压根没配」长得一样。
    expect(index).toMatch(/new AlarmChannel\(\s*\(\)\s*=>/);
    // 只断言「出现过一次 record(..., 'alert')」是不够的：把成功那条 .then 删掉，
    // catch 里那条照样匹配，守卫照样绿（第一版就是这么空转的，形状 1：判据太窄）。
    // 成功路径与失败路径必须各自在场。
    const records = [...index.matchAll(/alarmChannel\.record\([\s\S]{0,80}?'alert'/g)];
    expect(records.length, '成功与失败两条路径都要记账').toBeGreaterThanOrEqual(2);
    expect(index).toMatch(/\.then\(\([^)]*\)\s*=>\s*alarmChannel\.record\([^)]*'alert'/);
  });

  it('演练要走真实投递路径，不许造一条假的成功', () => {
    expect(index).toContain('runAlarmDrill');
    expect(index).toMatch(/alarmChannel\.record\([^)]*'drill'/);
    // 演练必须真的调 mapNotifier.send；只记账不发送等于自欺
    const drill = index.slice(index.indexOf('runAlarmDrill'), index.indexOf('runAlarmDrill') + 1200);
    expect(drill).toContain('notifier.send(');
  });

  it('摘要要下发通道状态，前端要读它（两头都在才算通）', () => {
    expect(uptime).toContain('alarmChannel?.()');
    expect(page).toContain('alarm={summary?.alarm}');
    expect(board).toContain('<AlarmRow');
  });

  it('前端不许给通道状态兜一个「健康」默认值', () => {
    // 只允许 `alarm={summary?.alarm}` 这种如实透传；出现 ?? 兜底即判红。
    expect(page).not.toMatch(/alarm=\{summary\?\.alarm\s*\?\?/);
  });
});

describe('通知通道凭据：只写不读', () => {
  const index = codeOf(read('../../src/index.ts'));
  const uptime = codeOf(read('../../src/routes/uptime.ts'));

  it('读接口回的是指纹，不是私钥本身', () => {
    expect(index).toContain('privateKeyFingerprint');
    // 回显里不许出现原文字段名（privateKey / privateKeyPem 直接回传即泄漏）
    const reader = index.slice(index.indexOf('readAlarmNotify:'), index.indexOf('writeAlarmNotify:'));
    expect(reader).not.toMatch(/privateKey:\s/);
    expect(reader).not.toMatch(/privateKeyPem:\s/);
  });

  it('凭据是 CDS 系统级的，项目级 Key 一律拒绝', () => {
    const block = uptime.slice(uptime.indexOf("'/cds-system/alarm-notify'"));
    expect(block).toContain('projectScopeOf(req)');
  });

  it('四项缺一即拒——半套凭据只会在真出事那天以 401 暴露', () => {
    expect(uptime).toMatch(/missing\.length > 0/);
  });
});
