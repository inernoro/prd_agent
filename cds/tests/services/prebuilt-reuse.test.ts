/**
 * 预构建镜像缺失时的「复用上一版」判定（2026-07-27 宕机复盘 P1）。
 *
 * 事故的临门一脚：push 只改了 cds/**，CI 正确地跳过了三个组件的镜像构建，
 * CDS 却把「拉不到 per-SHA 镜像」一律当成「需要在宿主全量重编」，三个组件同时
 * 源码构建，把已经 100% 的根盘压垮。
 *
 * 这里钉死两条边界：
 *  - 组件确实没变 → 必须复用，不许重编（省掉那一脚）；
 *  - 组件变了 / 判不出来 → 必须重编，不许复用（宁可慢也不能静默发旧代码）。
 */
import { describe, it, expect } from 'vitest';
import {
  shaFromImageTag, imageRepositoryOf, collectReuseCandidates, pickReusableImage, targetShaOf,
  normalizeBuildScope,
} from '../../src/services/prebuilt-reuse.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const REPO = 'ghcr.io/inernoro/prd_agent/prdagent-admin';

describe('镜像引用解析', () => {
  it('per-SHA tag 取得出 sha', () => {
    expect(shaFromImageTag(`${REPO}:sha-${SHA_A}`)).toBe(SHA_A);
  });

  it('浮动 tag / 无 tag / 短 sha 一律不认', () => {
    expect(shaFromImageTag(`${REPO}:latest`)).toBeNull();
    expect(shaFromImageTag(`${REPO}:main`)).toBeNull();
    expect(shaFromImageTag(REPO)).toBeNull();
    expect(shaFromImageTag(`${REPO}:sha-abc123`)).toBeNull();
  });

  it('带端口的私有仓库地址不会被误切', () => {
    expect(imageRepositoryOf('registry.local:5000/team/app:sha-' + SHA_A))
      .toBe('registry.local:5000/team/app');
    expect(imageRepositoryOf('registry.local:5000/team/app')).toBe('registry.local:5000/team/app');
  });
});

describe('候选收集', () => {
  const intended = `${REPO}:sha-${SHA_A}`;

  it('在跑的那一版排第一，台账按新到旧跟在后面', () => {
    const out = collectReuseCandidates({
      intendedImage: intended,
      runningImage: `${REPO}:sha-${SHA_B}`,
      ledgerImages: [`${REPO}:sha-${SHA_C}`],
    });
    expect(out.map((c) => [c.origin, c.sha])).toEqual([['running', SHA_B], ['ledger', SHA_C]]);
  });

  it('跨仓库的镜像一律排除——那是别的组件，复用等于跑错东西', () => {
    const out = collectReuseCandidates({
      intendedImage: intended,
      runningImage: 'ghcr.io/inernoro/prd_agent/prdagent-api:sha-' + SHA_B,
    });
    expect(out).toEqual([]);
  });

  it('浮动 tag 不作候选：无法据此断言与本次代码等价', () => {
    const out = collectReuseCandidates({ intendedImage: intended, runningImage: `${REPO}:latest` });
    expect(out).toEqual([]);
  });

  it('目标 sha 自身不作候选（它正是拉不到的那个）', () => {
    const out = collectReuseCandidates({ intendedImage: intended, runningImage: intended });
    expect(out).toEqual([]);
  });

  it('重复镜像只留一个', () => {
    const out = collectReuseCandidates({
      intendedImage: intended,
      runningImage: `${REPO}:sha-${SHA_B}`,
      ledgerImages: [`${REPO}:sha-${SHA_B}`, `${REPO}:sha-${SHA_C}`],
    });
    expect(out.map((c) => c.sha)).toEqual([SHA_B, SHA_C]);
  });
});

describe('复用判定', () => {
  const cands = collectReuseCandidates({
    intendedImage: `${REPO}:sha-${SHA_A}`,
    runningImage: `${REPO}:sha-${SHA_B}`,
    ledgerImages: [`${REPO}:sha-${SHA_C}`],
  });

  it('组件无变更 → 选中最优先的那一版（就是事故里本该走的路）', () => {
    const picked = pickReusableImage({ candidates: cands, isComponentUnchanged: () => true });
    expect(picked?.sha).toBe(SHA_B);
  });

  it('最新的一版变了、更旧的没变 → 跳过前者选后者', () => {
    const picked = pickReusableImage({
      candidates: cands,
      isComponentUnchanged: (sha) => sha === SHA_C,
    });
    expect(picked?.sha).toBe(SHA_C);
  });

  it('全都有变更 → 返回 null，照旧回退源码编译', () => {
    expect(pickReusableImage({ candidates: cands, isComponentUnchanged: () => false })).toBeNull();
  });

  it('判不出来（git 失败）等同有变更——宁可多编一次，也不静默发旧代码', () => {
    const picked = pickReusableImage({
      candidates: cands,
      isComponentUnchanged: () => { return false; },
    });
    expect(picked).toBeNull();
  });

  it('没有候选时返回 null', () => {
    expect(pickReusableImage({ candidates: [], isComponentUnchanged: () => true })).toBeNull();
  });
});

describe('比较基准是「目标 commit」而非 worktree HEAD（Codex PR #1275 P1）', () => {
  it('目标 sha 取自本次要拉的那个镜像 tag', () => {
    expect(targetShaOf(`${REPO}:sha-${SHA_A}`)).toBe(SHA_A);
  });

  it('浮动 tag 取不出目标 sha → 没有可信基准，调用方必须放弃复用', () => {
    expect(targetShaOf(`${REPO}:latest`)).toBeNull();
    expect(targetShaOf(REPO)).toBeNull();
    expect(targetShaOf('')).toBeNull();
  });

  it('对着目标 sha 比，才不会被「改了又 revert」的更晚 HEAD 骗过去', () => {
    // 场景：候选版本 B → 目标版本 A 之间改了该组件（有差异，不可复用）；
    // 但 HEAD 上那个改动已被 revert，B → HEAD 是干净的。若基准取 HEAD，
    // 旧镜像会被安静地当成用户点名的 A 发出去。
    const cands = collectReuseCandidates({
      intendedImage: `${REPO}:sha-${SHA_A}`,
      runningImage: `${REPO}:sha-${SHA_B}`,
    });
    const unchangedAgainstHead = () => true;   // B..HEAD 干净（revert 后）
    const unchangedAgainstTarget = () => false; // B..A 有差异（真实情况）

    expect(pickReusableImage({ candidates: cands, isComponentUnchanged: unchangedAgainstHead })).not.toBeNull();
    expect(pickReusableImage({ candidates: cands, isComponentUnchanged: unchangedAgainstTarget })).toBeNull();
  });
});

/**
 * 比较范围必须是 CI 构建输入，不是运行时挂载目录（Codex PR #1275 三轮 P1）。
 *
 * 本仓库 cds-compose.yml 里 api/admin/llmgw 都写 `.:/repo`，compose-parser 给出的
 * workDir 因此是 `.`。拿它 `git diff -- .` 等于比整个仓库：那次只改 cds/** 的提交
 * 照样「有差异」→ 判定组件变了 → 不复用 → 照旧三个组件同时在宿主重编。
 * 也就是说，不修这条，本 PR 的止损点在真实配置下一次都不会触发。
 */
describe('CI 构建范围（buildScope）的规整与拒绝', () => {
  it('正常的组件范围原样保留并去重', () => {
    expect(normalizeBuildScope(['prd-api/**', '.github/workflows/branch-image.yml', 'prd-api/**']))
      .toEqual(['prd-api/**', '.github/workflows/branch-image.yml']);
  });

  it('前导 ./ 归一化', () => {
    expect(normalizeBuildScope(['./prd-admin/**'])).toEqual(['prd-admin/**']);
  });

  it('仓库根等价物一律拒绝（这正是 workDir 的形态，比了等于没比）', () => {
    for (const bad of ['.', './', '/', '*', '**', '**/']) {
      expect(normalizeBuildScope([bad]), bad).toBeNull();
    }
  });

  it('一条是根等价物就整体拒绝，不许「掺一条根」把范围悄悄放大到全仓', () => {
    expect(normalizeBuildScope(['prd-api/**', '.'])).toBeNull();
  });

  it('绝对路径与 .. 拒绝（会跳出 worktree）', () => {
    expect(normalizeBuildScope(['/etc'])).toBeNull();
    expect(normalizeBuildScope(['../other-repo/**'])).toBeNull();
    expect(normalizeBuildScope(['prd-api/../../etc'])).toBeNull();
  });

  it('未声明 / 空 / 非数组 → null，调用方据此 fail-closed 不复用', () => {
    expect(normalizeBuildScope(undefined)).toBeNull();
    expect(normalizeBuildScope(null)).toBeNull();
    expect(normalizeBuildScope([])).toBeNull();
    expect(normalizeBuildScope(['', '   '])).toBeNull();
    expect(normalizeBuildScope('prd-api/**' as unknown as string[])).toBeNull();
  });
});
