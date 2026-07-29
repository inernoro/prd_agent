/**
 * release-center-deeplink.test.ts — 发布告警深链的 target / run 参数。
 *
 * 站内信里那条「查看发布记录」承诺打开出事的那个目标和那次发布
 * （notice-ledger 生成 `/release-center?project=&target=&run=`）。
 * 页面此前只读 project，多目标时会落到默认目标、也不会打开被点名的 run——
 * 运维顺着告警点进来看到的是一屏无关内容（Codex review P2，2026-07-29）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { releaseCenterDeepLink } from '../../web/src/lib/releaseCenter';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '../../web/src', rel), 'utf8');

describe('releaseCenterDeepLink', () => {
  it('解析 notice-ledger 产出的完整深链', () => {
    const params = new URLSearchParams('project=p1&target=rt_prod&run=rel_abc');
    expect(releaseCenterDeepLink(params)).toEqual({ targetId: 'rt_prod', runId: 'rel_abc' });
  });

  it('只带 target 时不编一个 run 出来', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('project=p1&target=rt_prod')))
      .toEqual({ targetId: 'rt_prod' });
  });

  it('只带 run 时不编一个 target 出来', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('run=rel_abc')))
      .toEqual({ runId: 'rel_abc' });
  });

  it('没有定位参数时返回空对象，页面按默认行为走', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('project=p1'))).toEqual({});
  });

  it('空白值当没给（`?target=` 这种残缺链接不该把选中态清成空）', () => {
    expect(releaseCenterDeepLink(new URLSearchParams('target=&run=%20'))).toEqual({});
  });
});

describe('页面真的消费了这两个参数（接线守卫）', () => {
  const page = read('pages/ReleaseCenterPage.tsx');

  it('初始选中态取自深链的 target', () => {
    expect(page).toContain('releaseCenterDeepLink');
    expect(page).toMatch(/useState\(deepLink\.targetId \|\| ''\)/);
  });

  it('深链点名的 run 会被打开成日志弹窗', () => {
    // 只断言「有人调用」不够：得断言它真的落到 setLogRun，
    // 否则参数解析了、选中了目标，弹窗仍然不开，用户还是看不到那次失败。
    const effect = page.slice(page.indexOf('pendingRunId'), page.indexOf('const selectedRow'));
    expect(effect).toMatch(/runs\.find\(\(run\) => run\.releaseId === pendingRunId\)/);
    expect(effect).toContain('setLogRun(target)');
    expect(effect).toContain('setSelectedTargetId(target.targetId)');
  });

  it('只弹一次：pending 用完即清，用户关掉不会被弹回来', () => {
    const effect = page.slice(page.indexOf('pendingRunId'), page.indexOf('const selectedRow'));
    expect(effect).toContain("setPendingRunId('')");
  });

  it('通知侧仍然在链接里带上 target 与 run（两头都在才叫一条链路）', () => {
    const ledger = fs.readFileSync(path.resolve(here, '../../src/services/notice-ledger.ts'), 'utf8');
    expect(ledger).toContain("params.set('target', data.targetId)");
    expect(ledger).toContain("params.set('run', data.releaseId)");
  });
});
