/**
 * 分支卡片「等高固定槽位 + 构建阶段条」守卫（2026-09-29 改版，取代 2026-09-08 方案 B 的
 * branch-card-footer-progress 守卫：那一版把整条页脚背景当进度条，本版换成顶边阶段条）。
 *
 * 事故：同一排卡片 207 / 226 / 253px 三种高度（用户截图），根因是卡片只有最低高度、
 * 网格按内容对齐，而卡里有五处「有时出现、有时不出现」的行。另一半是构建进度塞在
 * 页脚剩余宽度里，被截掉的恰好是排队位次与预计时长。
 *
 * 这里分两层：
 *   1. 阶段判定是纯函数，直接测行为（极速版四段 / 源码版三段 / 各状态落哪一段）；
 *   2. 页面接线测不了行为（那要真浏览器，见 scripts/branch-card-visual-audit.mjs），
 *      只钉「删掉就会退回高低不齐」的那几处，并各配一条红用例证明判据不空。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { branchCardPhase, isDeployPhase } from '../../web/src/lib/branchCardPhase';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (relative: string): string => fs.readFileSync(path.join(WEB_SRC, relative), 'utf-8');

describe('branchCardPhase：阶段只来自真实状态', () => {
  const running = { api: { status: 'running' } };

  it('运行中 / 已停止 / 出错 不在部署里，返回 null', () => {
    expect(branchCardPhase({ status: 'running', services: running })).toBeNull();
    expect(branchCardPhase({ status: 'idle', services: { api: { status: 'stopped' } } })).toBeNull();
    expect(branchCardPhase({ status: 'error', services: running, buildQueue: { ahead: 1 } })).toBeNull();
  });

  it('极速版四段、源码版三段——源码版没有「等镜像」，不硬凑空格子', () => {
    const express = branchCardPhase({ status: 'building', services: { api: { status: 'building' } }, prebuilt: true });
    expect(express?.steps.map((s) => s.label)).toEqual(['排队', '等待 CI 镜像', '启动容器', '就绪探测']);
    expect(express?.key).toBe('start');
    const source = branchCardPhase({ status: 'building', services: { api: { status: 'building' } }, prebuilt: false });
    expect(source?.steps.map((s) => s.label)).toEqual(['排队', '构建并启动', '就绪探测']);
    expect(source?.key).toBe('build');
  });

  it('优先级：排队 > 等镜像 > 构建 > 就绪', () => {
    expect(branchCardPhase({ status: 'building', buildQueue: { ahead: 5 }, ciImageStatus: 'waiting', prebuilt: true })?.key).toBe('queued');
    expect(branchCardPhase({ status: 'running', services: running, ciImageStatus: 'waiting' })?.key).toBe('ci-waiting');
    expect(branchCardPhase({ status: 'starting', services: { api: { status: 'starting' } }, prebuilt: true })?.key).toBe('ready');
    expect(branchCardPhase({ status: 'running', services: { api: { status: 'building' }, web: { status: 'running' } } })?.key).toBe('build');
  });

  it('已切回源码（prebuilt=false）的残留 CI 等待不算等镜像', () => {
    expect(branchCardPhase({ status: 'running', services: running, ciImageStatus: 'waiting', prebuilt: false })).toBeNull();
  });

  it('走过的段标 done、当前段 current、后面 todo', () => {
    const phase = branchCardPhase({ status: 'starting', prebuilt: true });
    expect(phase?.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current']);
    expect(phase?.showStep).toBe(true);
    expect(branchCardPhase({ status: 'building', buildQueue: { ahead: 0 } })?.showStep).toBe(false);
  });

  it('前端操作已发起、状态还没跟上：单段「处理中」而不是假装在某一段', () => {
    const phase = branchCardPhase({ status: 'running', services: running, pendingActionLabel: '正在拉取代码' });
    expect(phase?.key).toBe('working');
    expect(phase?.steps).toHaveLength(1);
  });

  it('一键重启（原地重启容器、没有构建）是单段「正在重启」，不冒充就绪探测', () => {
    const phase = branchCardPhase({ status: 'restarting', prebuilt: true, services: { api: { status: 'starting' } } as never });
    expect(phase?.key).toBe('restarting');
    expect(phase?.steps).toHaveLength(1);
    expect(phase?.showStep).toBe(false);
  });

  it('恢复部署（restarting 但服务在构建）仍按构建段显示', () => {
    expect(branchCardPhase({ status: 'restarting', prebuilt: true, services: { api: { status: 'building' } } as never })?.key).toBe('start');
  });

  it('只有部署阶段算部署：停止 / 重启 / 前端占位结束都不播「部署成功」', () => {
    const keyOf = (input: Parameters<typeof branchCardPhase>[0]) => branchCardPhase(input)!;
    expect(isDeployPhase(keyOf({ status: 'building' }))).toBe(true);
    expect(isDeployPhase(keyOf({ status: 'starting' }))).toBe(true);
    expect(isDeployPhase(keyOf({ status: 'building', buildQueue: { ahead: 0 } } as never))).toBe(true);
    expect(isDeployPhase(keyOf({ status: 'running', ciImageStatus: 'waiting', prebuilt: true }))).toBe(true);
    expect(isDeployPhase(keyOf({ status: 'restarting', services: { api: { status: 'starting' } } as never }))).toBe(false);
    expect(isDeployPhase(keyOf({ status: 'stopping' }))).toBe(false);
    expect(isDeployPhase(keyOf({ status: 'running', pendingActionLabel: '正在拉取代码' }))).toBe(false);
  });
});

describe('卡片等高：固定高度 + 网格拉齐', () => {
  const page = read('pages/BranchListPage.tsx');
  const css = read('index.css');

  const cardFixed = (source: string) => {
    const at = source.indexOf('data-branch-card-id={branch.id}');
    expect(at).toBeGreaterThan(-1);
    const root = source.slice(at, at + 400);
    expect(root, '卡片根必须是固定高度，只给最低高度就会被内容撑成高低不齐').toMatch(/\bh-\[15\.25rem\]/);
    expect(root).not.toMatch(/min-h-\[/);
  };
  const gridStretch = (source: string) => {
    const block = source.slice(source.indexOf('.cds-branch-card-grid {'), source.indexOf('.cds-branch-card-grid {') + 900);
    expect(block).toMatch(/align-items:\s*stretch;/);
  };

  it('卡片根固定高度、网格 stretch', () => {
    cardFixed(page);
    gridStretch(css);
  });

  it('红用例：卡片根退回最低高度，守卫变红', () => {
    expectGuardRedOnMutation(cardFixed, page, mutate(page, 'flex h-[15.25rem] cursor-pointer', 'flex min-h-[15.25rem] cursor-pointer'));
  });

  it('红用例：网格退回 align-items: start，守卫变红', () => {
    const block = css.indexOf('.cds-branch-card-grid {');
    const mutated = css.slice(0, block) + mutate(css.slice(block), 'align-items: stretch;', 'align-items: start;');
    expectGuardRedOnMutation(gridStretch, css, mutated);
  });

  it('骨架与复制集派生卡同高，否则加载切换那一帧、复制集那一排又会跳', () => {
    expect(read('components/skeletons/PageSkeletons.tsx')).toContain('flex h-[15.25rem] flex-col');
    expect(page).toContain('relative flex h-[15.25rem] flex-col overflow-hidden rounded-xl border-2');
  });

  // 复制集卡固定高度后，成员区必须是卡内唯一可伸缩、可滚动的一格；否则成员多到换好几行时
  // 会把「打开详情 / 预览本组」挤出卡片、被 overflow-hidden 裁掉（Codex P2）。
  const replicaMembersScroll = (source: string) => {
    expect(source).toContain('data-replica-members className="flex min-h-0 max-w-full flex-1 flex-wrap content-start items-center gap-2 overflow-y-auto');
    expect(source).toContain('<div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-4 pt-3">');
  };

  it('复制集卡成员区在卡内滚动，操作按钮始终留在卡底', () => {
    replicaMembersScroll(page);
  });

  it('红用例：成员区退回不限高，守卫变红', () => {
    expectGuardRedOnMutation(
      replicaMembersScroll,
      page,
      mutate(page, 'flex min-h-0 max-w-full flex-1 flex-wrap content-start items-center gap-2 overflow-y-auto', 'flex max-w-full flex-wrap items-center gap-2'),
    );
  });
});

describe('构建页脚：阶段条接线', () => {
  const page = read('pages/BranchListPage.tsx');
  const css = read('index.css');

  it('卡片与页头汇总共用 branchCardPhase 一个判定源', () => {
    const calls = page.split('branchCardPhase({').length - 1;
    expect(calls, '卡片页脚 + 页头汇总两处调用').toBe(2);
    expect(page).toContain("import { branchCardPhase, isDeployPhase, type BranchCardPhase } from '@/lib/branchCardPhase';");
  });

  const wired = (source: string) => {
    expect(source).toContain('data-deploy-phase={deployPhaseAttr}');
    expect(source).toContain('phaseBarSource.steps.map((step) => (');
    expect(source).toContain('data-footer-status');
  };

  it('卡片根暴露机读阶段、页脚渲染阶段条与状态行', () => {
    wired(page);
  });

  it('红用例：拆掉机读阶段属性，守卫变红', () => {
    expectGuardRedOnMutation(wired, page, mutate(page, 'data-deploy-phase={deployPhaseAttr}', ''));
  });

  // 「处理中」是任意前端操作的占位、「正在重启」是原地重启，结束都不等于部署完成。
  // 收尾只能由真实部署阶段触发，否则一次「打开预览」就会误播「部署成功」（Codex P2）。
  const finishOnlyFromRealDeploy = (source: string) => {
    expect(source).toContain('if (buildPhase && buildClock && isDeployPhase(buildPhase)) {');
  };

  it('收尾只由真实部署阶段触发，「处理中」不记为一次构建', () => {
    finishOnlyFromRealDeploy(page);
  });

  it('红用例：「处理中」也记为构建，守卫变红', () => {
    expectGuardRedOnMutation(
      finishOnlyFromRealDeploy,
      page,
      mutate(page, 'if (buildPhase && buildClock && isDeployPhase(buildPhase)) {', 'if (buildPhase && buildClock) {'),
    );
  });

  // 单服务重建时分支仍是 running：时钟与起算点必须跟着阶段条走，而不是只看分支级状态，
  // 否则页脚停在 00:00、永远不会「超出预计」（Codex P2）。
  const clockFollowsPhase = (source: string) => {
    expect(source).toContain('const deployInFlight = Boolean(buildPhase && isDeployPhase(buildPhase));');
    expect(source).toMatch(/useNowTick\(\s*busy\s*\|\| deployInFlight/);
    expect(source).toContain(': deployInFlight ? branch.lastDeployStartedAt || branchBusySince(branch, action) : undefined;');
  };

  it('单服务重建也走表：时钟与起算点跟阶段条走', () => {
    clockFollowsPhase(page);
  });

  it('红用例：时钟只看分支级状态，守卫变红', () => {
    expectGuardRedOnMutation(clockFollowsPhase, page, mutate(page, '    || deployInFlight\n', ''));
  });

  it('旧的整条背景填充已退场，不留两套进度表达', () => {
    expect(page).not.toContain('cds-footer-progress-fill');
    expect(css).not.toContain('cds-footer-progress-fill');
  });

  // 卡片根挂着 duration-150；tailwindcss-animate 让它同时改写 animation-duration，且 utilities
  // 层压过组件层。不加 !important，外圈脉冲 / 进场 / 退场都会被静默截成 150ms（取证脚本量出来的）。
  const durationsPinned = (source: string) => {
    for (const [cls, ms] of [['cds-finish-ring', 780], ['cds-branch-card-enter', 440], ['cds-branch-card-leave', 340]] as const) {
      const at = source.indexOf(`.${cls} {`);
      expect(at, cls).toBeGreaterThan(-1);
      expect(source.slice(at, at + 520), `${cls} 的时长必须钉死`).toContain(`animation-duration: ${ms}ms !important;`);
    }
  };

  it('卡片动画时长钉死，不被 duration-150 截短', () => {
    expect(page).toMatch(/flex h-\[15\.25rem\] cursor-pointer flex-col[\s\S]{0,1200}duration-150/);
    durationsPinned(css);
  });

  it('红用例：去掉外圈脉冲的时长钉子，守卫变红', () => {
    expectGuardRedOnMutation(durationsPinned, css, mutate(css, 'animation-duration: 780ms !important;', ''));
  });

  it('阶段条与收尾动效颜色走 token，且尊重 reduced-motion', () => {
    const block = css.slice(css.indexOf('.cds-phase-bar {'), css.indexOf('.cds-roll-in {'));
    expect(block.length).toBeGreaterThan(500);
    expect(block, '颜色必须走 token，双主题才都成立').not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(\s*\d/i);
    const reduced = css.slice(css.indexOf('.cds-roll-in {'));
    expect(reduced).toMatch(/prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.cds-phase-seg--current::after/);
  });
});
