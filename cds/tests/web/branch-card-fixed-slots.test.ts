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

import { branchCardPhase, deployOutcome, deployingServiceIds, isDeployPhase, isDeployStartedPhase } from '../../web/src/lib/branchCardPhase';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (relative: string): string => fs.readFileSync(path.join(WEB_SRC, relative), 'utf-8');

describe('branchCardPhase：阶段只来自真实状态', () => {
  const running = { api: { status: 'running' } };

  it('运行中 / 已停止 / 出错 不在部署里，返回 null', () => {
    expect(branchCardPhase({ status: 'running', services: running })).toBeNull();
    expect(branchCardPhase({ status: 'idle', services: { api: { status: 'stopped' } } })).toBeNull();
    expect(branchCardPhase({ status: 'error', services: running, buildQueue: { ahead: 1 } })).toBeNull();
    // 分支出错而服务残留 building / starting（排构建槽时失败）：仍是终态，不推构建阶段
    expect(branchCardPhase({ status: 'error', services: { api: { status: 'building' } }, prebuilt: false })).toBeNull();
    expect(branchCardPhase({ status: 'error', services: { api: { status: 'starting' } } })).toBeNull();
  });

  it('极速版四段、源码版三段——源码版没有「等镜像」，不硬凑空格子', () => {
    const express = branchCardPhase({ status: 'building', services: { api: { status: 'building' } }, prebuilt: true });
    expect(express?.steps.map((s) => s.label)).toEqual(['排队', '等待 CI 镜像', '启动容器', '就绪探测']);
    expect(express?.key).toBe('start');
    const source = branchCardPhase({ status: 'building', services: { api: { status: 'building' } }, prebuilt: false });
    expect(source?.steps.map((s) => s.label)).toEqual(['排队', '构建并启动', '就绪探测']);
    expect(source?.key).toBe('build');
  });

  it('极速版与源码版混着的分支：按这次正在部署的服务选步骤，不按「任一走极速版」（Codex P2）', () => {
    const mixed = { prebuilt: true, prebuiltProfileIds: ['web'] };
    // 只重部署源码服务 api：本机编译，得是源码版三段
    const sourceOnly = branchCardPhase({ status: 'running', services: { api: { status: 'building' }, web: { status: 'running' } }, ...mixed });
    expect(sourceOnly?.key).toBe('build');
    expect(sourceOnly?.label).toBe('构建并启动');
    // 只重部署极速版服务 web：拉镜像起容器，四段
    const expressOnly = branchCardPhase({ status: 'running', services: { api: { status: 'running' }, web: { status: 'building' } }, ...mixed });
    expect(expressOnly?.key).toBe('start');
    // 两种一起动：有本机编译就不许说成「启动容器」
    expect(branchCardPhase({ status: 'building', services: { api: { status: 'building' }, web: { status: 'building' } }, ...mixed })?.key).toBe('build');
    // 服务各自结束：源码服务 api 已回 running、极速版 web 还在探测——这次部署编译过源码，不许翻成极速版步骤
    const staggered = branchCardPhase({ status: 'starting', services: { api: { status: 'running' }, web: { status: 'starting' } }, ...mixed, participants: ['api', 'web'] });
    expect(staggered?.steps.map((step) => step.label)).toEqual(['排队', '构建并启动', '就绪探测']);
    // 整分支部署刚开始：分支先翻 building、还没有服务在动。混合分支（2 个服务只 1 个极速版）按源码版，
    // 全部极速版才按极速版；排队时按排队登记的服务判
    expect(branchCardPhase({ status: 'building', services: { api: { status: 'running' }, web: { status: 'running' } }, ...mixed, activeProfileCount: 2 })?.key).toBe('build');
    expect(branchCardPhase({ status: 'building', services: { web: { status: 'running' } }, prebuilt: true, prebuiltProfileIds: ['web'], activeProfileCount: 1 })?.key).toBe('start');
    expect(branchCardPhase({ status: 'building', buildQueue: { ahead: 1, serviceIds: ['api'] }, ...mixed, activeProfileCount: 2 })?.steps).toHaveLength(3);
    // 部署开头已定为源码步骤：源码服务提前失败、之后只剩极速版服务在探测，也不翻成极速版
    const locked = branchCardPhase({ status: 'starting', services: { api: { status: 'error' }, web: { status: 'starting' } }, ...mixed, participants: ['web'], lockedExpress: false });
    expect(locked?.steps.map((step) => step.label)).toEqual(['排队', '构建并启动', '就绪探测']);
    // 没有服务在动（排队 / 等镜像）时仍按 prebuilt
    expect(branchCardPhase({ status: 'running', services: { api: { status: 'running' } }, ciImageStatus: 'waiting', ...mixed })?.key).toBe('ci-waiting');
  });

  it('后端随分支下发走极速版的 profile 列表，页面两处阶段推导都接上', () => {
    const routes = fs.readFileSync(path.join(WEB_SRC, '../../src/routes/branches.ts'), 'utf8');
    const page = read('pages/BranchListPage.tsx');
    expect(routes).toContain('prebuiltProfileIds.push(profile.id);');
    expect(routes).toMatch(/prebuilt,\n\s+prebuiltProfileIds,/);
    expect(page.match(/prebuiltProfileIds: branch\.deployRuntime\?\.prebuiltProfileIds,/g)).toHaveLength(2);
    // 卡片把自己记住的参与服务交给阶段推导
    expect(page).toContain('participants: lastBuildRef.current?.serviceIds,');
    expect(page).toContain("express: lastBuildRef.current?.started ? lastBuildRef.current.express : buildPhase.steps.some((step) => step.key === 'ci-waiting'),");
    // 分支 idle 但有服务在部署（从停止状态单独部署一个服务）：不收进「未运行」分组
    expect(page).toContain('  if (deployingServiceIds(branch.services).length > 0) return false;');
    // 信息槽的模式文案跟阶段条同一个判断：阶段是源码三段时不许还说「极速版」
    expect(page).toContain("const modeText = phaseIsSourceSequence && deployModeLabel(branch) === '极速版' ? '源码编译' : deployModeLabel(branch);");
    expect(page.match(/activeProfileCount: branch\.deployRuntime\?\.activeProfiles,/g)).toHaveLength(2);
    // 单服务部署的每次状态翻转都推事件：building / starting / 结束（成功、超时、出错都在聚合状态重算后推一次）
    expect(routes.match(/emitServiceTransition\(\);/g)).toHaveLength(3);
    // 分支不在运行（停止 / 出错后重试）时单服务部署带着聚合状态走中间态，卡片不必从服务状态去猜
    expect(routes).toContain("      if (entry.status !== 'running') entry.status = 'building';");
    expect(routes).toContain("        if (entry.status === 'building') entry.status = 'starting';");
    // 整分支部署多层依赖：每个服务开始构建都推一条，下一层构建时卡片不停在上一层的「就绪探测」
    const layerBuild = routes.indexOf("          svc.status = 'building';\n          // 每个服务开始构建都推一条");
    expect(layerBuild).toBeGreaterThan(0);
    expect(routes.slice(layerBuild, layerBuild + 600)).toContain("type: 'branch.updated',");
    // 单服务部署开始时同样按轮清零排队时长（计时 = 开始至今 − 排队时长）
    const singleStart = routes.indexOf('// 排队时长按轮重置，与整分支部署一致');
    expect(singleStart).toBeGreaterThan(0);
    expect(routes.slice(singleStart, singleStart + 300)).toContain('entry.lastDeployQueueWaitMs = 0;');
    // 外层失败（如排构建槽时被取消）也推一条，已打开的列表不停在「构建中」
    expect(routes).toContain('// 失败也要推一条：比如排构建槽时被取消');
    // 结束那一条必须排在分支聚合状态重算之后，否则从停止状态起服务时卡片拿到的还是 idle
    const finalize = routes.indexOf("entry.status = hasRunning ? 'running' : hasStarting ? 'starting' : 'error';");
    const lastEmit = routes.lastIndexOf('emitServiceTransition();');
    expect(finalize).toBeGreaterThan(0);
    expect(lastEmit).toBeGreaterThan(finalize);
    // 而且在状态落盘确认之后：落盘失败时接口不报成功，卡片也不能先播「部署成功」
    const between = routes.slice(finalize, lastEmit);
    expect(between).toContain("if (flushResult !== 'flushed') {");
    expect(between).not.toContain("sendSSE(res, 'complete'");
    // 落盘失败那条出口同样推结束事件，否则已打开的列表停在「就绪探测」
    const flushFail = routes.indexOf("if (flushResult !== 'flushed') {", finalize);
    const flushFailReturn = routes.indexOf('return;', flushFail);
    expect(flushFail).toBeGreaterThan(finalize);
    // 而且带上 stateFlushFailed：卡片离开部署阶段，但不能把接口报失败的这次播成「部署成功」
    expect(routes.slice(flushFail, flushFailReturn)).toContain('emitServiceTransition({ stateFlushFailed: true });');
    expect(page).toContain('if (branch.stateFlushFailed) return;');
    // 标记只属于那一条事件：每条 branch.updated / branch.status 都显式写 true / false，不在合并里残留
    expect(page).toContain('branch: { ...data.branch, stateFlushFailed: Boolean(data.stateFlushFailed) },');
    expect(page).toContain('branch: { ...data.branch, status: data.status, stateFlushFailed: false },');
    // 页头汇总与卡片同一判断：卡片在部署阶段就算在构建，只有被动等镜像让位给真实失败
    expect(page).toContain("const cardPhase = phase?.key === 'ci-waiting' && failed ? null : phase;");
    // 出错类别只按现有构建配置对应的服务算，与出错原因同口径
    expect(page).toContain('branchIssueLabel(branch, projectProfileIds)');
    // 构建 / 起容器 / 就绪探测的计时从本次部署开始（lastDeployStartedAt）算，排队与等镜像沿用原起点
    expect(page).toContain("const anchoredToDeployStart = deployInFlight && buildPhase?.key !== 'queued' && buildPhase?.key !== 'ci-waiting';");
    // 耗时预计取哪个样本桶，与阶段条同一个判断：混合分支只重建源码服务时取源码样本
    expect(page).toContain('pickDeployEstimate(branch, phaseIsSourceSequence)');
    // 等 CI 镜像期间有服务真的失败：失败优先，不盖在等镜像下面
    expect(page).toContain("phaseFromState?.key === 'ci-waiting' && branchHasDeployFailure(branch, projectProfileIds)");
    // 真实部署结束后回到等 CI 镜像：清掉上一次的部署记录，新的等待期不继承「已开始」与步骤锁
    expect(page).toContain("if (buildPhase.key === 'ci-waiting' && lastBuildRef.current?.started) lastBuildRef.current = null;");
    // 步骤类型只在真的开始部署之后锁定：只是等 CI 镜像那一段不锁
    expect(page).toContain('lockedExpress: lastBuildRef.current?.started ? lastBuildRef.current.express : undefined,');
  });

  it('优先级：排队 > 构建 > 就绪 > 等镜像；等 CI 镜像期间手动部署，阶段条跟着真实部署走', () => {
    // 后端允许等镜像期间手动部署，分支状态走 building / starting，而 ciImageStatus 仍是 waiting
    expect(branchCardPhase({ status: 'building', services: { api: { status: 'building' } }, ciImageStatus: 'waiting', prebuilt: true })?.key).toBe('start');
    expect(branchCardPhase({ status: 'building', services: { api: { status: 'building' } }, ciImageStatus: 'waiting', prebuilt: false })?.key).toBe('build');
    expect(branchCardPhase({ status: 'starting', services: { api: { status: 'starting' } }, ciImageStatus: 'waiting', prebuilt: true })?.key).toBe('ready');
    expect(branchCardPhase({ status: 'running', services: { api: { status: 'starting' } }, ciImageStatus: 'waiting', prebuilt: true })?.key).toBe('ready');
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

  it('单服务部署进入就绪探测时分支仍 running：认作就绪探测段，不提前报成功', () => {
    const phase = branchCardPhase({ status: 'running', prebuilt: true, services: { api: { status: 'starting' }, admin: { status: 'running' } } });
    expect(phase?.key).toBe('ready');
    // 原地重启同样是服务 starting，但分支是 restarting，仍归「正在重启」
    expect(branchCardPhase({ status: 'restarting', services: { api: { status: 'starting' } } })?.key).toBe('restarting');
    // 分支 idle 而服务残留 starting（运行时容量对账的调试态）不算部署
    expect(branchCardPhase({ status: 'idle', services: { api: { status: 'starting' } } })).toBeNull();
  });

  it('参与部署的服务 = 此刻 building / starting 的那些', () => {
    expect(deployingServiceIds({ api: { status: 'building' }, admin: { status: 'running' }, web: { status: 'starting' } })).toEqual(['api', 'web']);
    expect(deployingServiceIds(undefined)).toEqual([]);
  });

  it('收尾成败按参与部署的服务判：单服务失败而分支仍 running，不许报成功', () => {
    const services = { api: { status: 'error' }, admin: { status: 'running' } };
    expect(deployOutcome({ status: 'running', services, participants: ['api'], started: true })).toEqual({ kind: 'failed', failedServiceIds: ['api'] });
    // 没参与这次部署的服务早就是 error：不算这次失败
    expect(deployOutcome({ status: 'running', services, participants: ['admin'], started: true })).toEqual({ kind: 'done', failedServiceIds: [] });
    expect(deployOutcome({ status: 'error', services, participants: [], started: true })?.kind).toBe('failed');
    expect(deployOutcome({ status: 'idle', services, participants: ['admin'], started: true })).toBeNull();
  });

  it('只在排队 / 等镜像里结束的（CI 失败、排队取消）不是一次部署：不报成功', () => {
    const healthy = { api: { status: 'running' } };
    // 极速版等镜像时旧版本在跑，CI 失败后 ciImageStatus 翻 failed、分支仍 running
    expect(deployOutcome({ status: 'running', services: healthy, participants: [], started: false })).toBeNull();
    // 真失败（分支出错）仍要报
    expect(deployOutcome({ status: 'error', services: healthy, participants: [], started: false })?.kind).toBe('failed');
    const phaseOf = (input: Parameters<typeof branchCardPhase>[0]) => branchCardPhase(input)!;
    expect(isDeployStartedPhase(phaseOf({ status: 'running', ciImageStatus: 'waiting', prebuilt: true }))).toBe(false);
    expect(isDeployStartedPhase(phaseOf({ status: 'building', buildQueue: { ahead: 0 } } as never))).toBe(false);
    expect(isDeployStartedPhase(phaseOf({ status: 'building' }))).toBe(true);
    expect(isDeployStartedPhase(phaseOf({ status: 'starting' }))).toBe(true);
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
  // 真实几何（溢出时卡内滚动、「打开详情」留在卡内）由 scripts/branch-card-visual-audit.mjs 在浏览器里量；
  // 这里只做 CI 里的廉价兜底：看成员区的类名集合，不依赖类名顺序或 JSX 写法（Codex P2，PR #1646）。
  const classTokensAfter = (source: string, marker: string): Set<string> => {
    const at = source.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    const match = /className="([^"]*)"/.exec(source.slice(at, at + 400));
    expect(match).not.toBeNull();
    return new Set((match?.[1] || '').split(/\s+/).filter(Boolean));
  };
  const replicaMembersScroll = (source: string) => {
    const members = classTokensAfter(source, 'data-replica-members');
    for (const token of ['flex-1', 'min-h-0', 'overflow-y-auto']) expect(members.has(token)).toBe(true);
    const footerAt = source.lastIndexOf('<div', source.indexOf('>打开详情</Button>', source.indexOf('data-replica-members')));
    expect(classTokensAfter(source.slice(footerAt), '<div').has('shrink-0')).toBe(true);
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
    expect(page).toContain("import { branchCardPhase, deployOutcome, deployingServiceIds, isDeployPhase, isDeployStartedPhase, type BranchCardPhase } from '@/lib/branchCardPhase';");
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

  // 收尾结果必须经 deployOutcome（按参与部署的服务判），不许退回只看 branch.status。
  const outcomeFromParticipants = (source: string) => {
    expect(source).toContain('const result = deployOutcome({ status: branch.status, services: branch.services, participants: last.serviceIds, started: last.started });');
    expect(source).toContain('...deployingServiceIds(branch.services)');
    expect(source).toContain('const failedPhase = failureStillShowing && outcome ? outcome.phase : null;');
  };

  it('收尾成败按参与部署的服务判，单服务失败也进失败态', () => {
    outcomeFromParticipants(page);
  });

  it('红用例：失败态退回只认分支级 error，守卫变红', () => {
    expectGuardRedOnMutation(
      outcomeFromParticipants,
      page,
      mutate(page, 'const failedPhase = failureStillShowing && outcome ? outcome.phase : null;', "const failedPhase = outcome?.kind === 'failed' && isError ? outcome.phase : null;"),
    );
  });

  // 页头「出错需要处理」与「重新部署失败项」共用 branchHasDeployFailure：单服务失败、分支仍 running 也算出错。
  const overviewCountsServiceFailures = (source: string) => {
    expect(source).toContain('const failed = branchHasDeployFailure(branch, projectProfileIds);');
    expect(source).toContain("if (branch.status === 'error' || (failed && !cardPhase)) errored += 1;");
    expect(source).toContain('if (!branchHasDeployFailure(branch, projectProfileIds)) continue;');
    expect(source.match(/function branchHasDeployFailure\(/g)).toHaveLength(1);
  };

  // 刷新后没有「刚才那次翻转」：卡片必须从持久的服务状态认出单服务失败，和页头计数一致。
  const cardShowsPersistedServiceFailure = (source: string) => {
    expect(source).toContain('const serviceFailed = !isError && !buildPhase && branchHasDeployFailure(branch, projectProfileIds);');
    expect(source).toContain('{showsIssue && !failedPhase ? (');
    expect(source).toContain(') : showsIssue || failedPhase ? (');
  };

  // 列表排序的「出错置顶」也走同一判据；定位收起分组里的卡片前先展开分组。
  const sortAndFocusWired = (source: string) => {
    expect(source).toContain('const isErrored = (b: BranchSummary): boolean => branchHasDeployFailure(b, projectProfileIds);');
    expect(source).toContain('if (dormantIdsRef.current.has(branchId)) setDormantCollapsed(false);');
    // 已停止判定取未经标签筛选的全部分支：定位会先清筛选（Codex P2）
    expect(source).toContain('dormantIdsRef.current = new Set(branches.filter((branch) => isDormantBranch(branch, actions[branch.id])).map((branch) => branch.id));');
  };

  it('出错置顶按服务级失败算；定位已停止分支前先展开分组', () => {
    sortAndFocusWired(page);
  });

  it('红用例：排序退回只看分支级 error，守卫变红', () => {
    expectGuardRedOnMutation(
      sortAndFocusWired,
      page,
      mutate(page, 'const isErrored = (b: BranchSummary): boolean => branchHasDeployFailure(b, projectProfileIds);', "const isErrored = (b: BranchSummary): boolean => b.status === 'error';"),
    );
  });

  it('刷新后单服务失败的卡片仍按出错呈现（与页头计数同一判据）', () => {
    cardShowsPersistedServiceFailure(page);
  });

  it('红用例：出错呈现退回只看分支级 error，守卫变红', () => {
    expectGuardRedOnMutation(cardShowsPersistedServiceFailure, page, mutate(page, '{showsIssue && !failedPhase ? (', '{isError && !failedPhase ? ('));
  });

  it('页头出错计数算上服务级失败，与重新部署失败项共用一个判据', () => {
    overviewCountsServiceFailures(page);
  });

  it('红用例：页头出错计数退回只看分支状态，守卫变红', () => {
    expectGuardRedOnMutation(
      overviewCountsServiceFailures,
      page,
      mutate(page, 'const failed = branchHasDeployFailure(branch, projectProfileIds);', "const failed = branch.status === 'error';"),
    );
  });

  // 僵尸服务（构建配置已删、条目因分支忙没清掉）不算这条分支坏了：判据只认项目配置 + 分支额外服务里还在的 profile；
  // 配置没取到时不过滤（宁可多报，不静默藏掉真实失败）。
  const failureIgnoresZombieServices = (source: string) => {
    expect(source).toContain('if (!projectProfileIds) return failed;');
    expect(source).toContain('return failed.filter((service) => projectProfileIds.has(service.profileId) || extraIds.has(service.profileId));');
    expect(source).toContain('return branch.status === \'error\' || failedLiveServices(branch, projectProfileIds).length > 0;');
    expect(source).toContain('state.status === \'ok\' && state.buildProfilesLoaded');
    expect(source).toContain('const buildProfilesLoaded = profilesResult.status === \'fulfilled\';');
    expect(source).toContain('projectProfileIds={projectProfileIds}');
    // 卡片里的失败文案也走同一份过滤，不再各自扫全部 services
    expect(source).not.toMatch(/deployFailureMessage\(branch\)/);
  };

  it('出错判据排除僵尸服务，配置没取到时不过滤', () => {
    failureIgnoresZombieServices(page);
  });

  it('红用例：判据退回扫全部 services，守卫变红', () => {
    expectGuardRedOnMutation(
      failureIgnoresZombieServices,
      page,
      mutate(page, 'return branch.status === \'error\' || failedLiveServices(branch, projectProfileIds).length > 0;', "return branch.status === 'error' || Object.values(branch.services || {}).some((service) => service.status === 'error');"),
    );
  });

  // 复制集标识与端口 chip 同在一条单行槽：它占一格，端口就少露一个，否则最窄卡宽下「+N」被裁掉。
  const replicaInChipBudget = (source: string) => {
    expect(source).toContain('const portRowMarkers = [replicaEntries.length > 0, ciFailedChip, infraErrorChip, driftChip].filter(Boolean).length;');
    expect(source).toContain('const appChipBudget = Math.max(0, APP_CHIP_FOLD_THRESHOLD - portRowMarkers);');
    // 「CI 失败」只是一个短标记，不再是一整串文字加两个按钮
    expect(source).not.toContain('>切回源码编译</button>');
    expect(source).toContain('? appResources.slice(0, appChipBudget)');
    expect(source).not.toContain('const shown = entries.slice(0, 4);');
  };

  it('端口行所有附加标记（复制集 / CI 失败 / 基础设施异常 / 配置漂移）都计入折叠预算', () => {
    replicaInChipBudget(page);
  });

  it('红用例：复制集标识不计入预算，守卫变红', () => {
    expectGuardRedOnMutation(
      replicaInChipBudget,
      page,
      mutate(page, '? appResources.slice(0, appChipBudget)', '? appResources.slice(0, APP_CHIP_FOLD_THRESHOLD)'),
    );
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
