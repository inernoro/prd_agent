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
  shaFromImageTag, imageRepositoryOf, collectReuseCandidates, pickReusableImage,
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
