/**
 * 发布目标变更历史的判定回归。
 *
 * 要守住三件事：
 *   1. diff 算的是「落库前 vs 落库后」，不是请求体的 key 集合；
 *   2. 凭据引用只留指纹，绝不原样入历史；
 *   3. 历史有上限，不会随改配置次数无限长。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReleaseTarget } from '../../src/types.js';
import {
  MAX_CHANGES_PER_TARGET,
  ReleaseTargetHistoryStore,
  diffReleaseTarget,
  formatTrackedValue,
  recordReleaseTargetUpsert,
  resolveChangeKind,
} from '../../src/services/release-target-history.js';

function target(overrides: Partial<ReleaseTarget> = {}): ReleaseTarget {
  return {
    id: 'tgt-prod',
    projectId: 'proj',
    name: '官网',
    type: 'ssh',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    isEnabled: true,
    lifecycle: 'active',
    environment: 'production',
    isCanonical: true,
    strategy: { mode: 'existing-script', command: './deploy.sh' },
    ssh: {
      host: '10.0.0.1',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-prod-key',
      appPath: '/opt/app',
      deployCommand: './deploy.sh',
      rollbackCommand: '',
      healthcheckUrl: 'https://prod.example.test/api/health',
    },
    ...overrides,
  } as ReleaseTarget;
}

describe('字段级 diff', () => {
  it('改健康检查地址 → 恰好一条变更，带人话字段名', () => {
    const before = target();
    const after = target({
      ssh: { ...before.ssh!, healthcheckUrl: 'https://prod.example.test/healthz' },
      // updatedAt 每次落库都会变，但它不在白名单里，不许污染历史。
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    const changes = diffReleaseTarget(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: 'ssh.healthcheckUrl',
      label: '健康检查地址',
      before: 'https://prod.example.test/api/health',
      after: 'https://prod.example.test/healthz',
    });
  });

  it('只改 name 的请求也能带出 deployCommand 变化', () => {
    // 事故值：按请求 body 的 key 集合算 diff。PATCH 只传 name 时，
    // ssh.deployCommand 仍会被路由从 strategy 反推重算（非 existing-script 模式一律
    // 置空串），于是「发布命令被清空」这件大事在历史里一个字都没有。
    const before = target();
    const after = target({
      name: '官网（新）',
      strategy: { mode: 'generated-compose', composeFile: 'compose.yml', composeProject: 'p-prod' },
      ssh: { ...before.ssh!, deployCommand: '' },
    });
    const paths = diffReleaseTarget(before, after).map((c) => c.path);
    expect(paths).toContain('name');
    expect(paths).toContain('ssh.deployCommand');
    expect(paths).toContain('strategy.mode');
  });

  it('新建时把所有初始值记成 only-after', () => {
    const changes = diffReleaseTarget(undefined, target());
    expect(resolveChangeKind(undefined, target())).toBe('created');
    const healthcheck = changes.find((c) => c.path === 'ssh.healthcheckUrl');
    expect(healthcheck?.before).toBeUndefined();
    expect(healthcheck?.after).toBe('https://prod.example.test/api/health');
  });

  it('归档识别为 archived 而不是普通更新', () => {
    const before = target();
    const after = target({ lifecycle: 'archived', isEnabled: false, isCanonical: false });
    expect(resolveChangeKind(before, after)).toBe('archived');
  });

  it('空串与缺省视为同一件事，不刷出假变更', () => {
    const before = target({ ssh: { ...target().ssh!, rollbackCommand: '' } });
    const after = target({ ssh: { ...target().ssh!, rollbackCommand: undefined as unknown as string } });
    expect(diffReleaseTarget(before, after)).toHaveLength(0);
  });
});

describe('敏感值', () => {
  it('privateKeyRef 只留指纹，原值不进历史', () => {
    // 事故值：历史留痕的读权限比发布目标本身宽，原样写进去等于把
    // 「哪台机器用哪把钥匙」摊开给所有能翻审计的人。
    const before = target();
    const after = target({ ssh: { ...before.ssh!, privateKeyRef: 'host-backup-key' } });
    const change = diffReleaseTarget(before, after).find((c) => c.path === 'ssh.privateKeyRef');
    expect(change).toBeDefined();
    expect(change!.before).not.toContain('host-prod-key');
    expect(change!.after).not.toContain('host-backup-key');
    expect(change!.before).toMatch(/^ref:[0-9a-f]{12}$/);
    // 指纹仍必须能回答「换没换」这个唯一有价值的问题。
    expect(change!.before).not.toBe(change!.after);
  });

  it('发布命令里内联的密钥被脱敏', () => {
    const value = formatTrackedValue('DEPLOY_TOKEN=abcdef123456 ./deploy.sh', 'strategy.command');
    expect(value).not.toContain('abcdef123456');
  });

  it('超长值被截断，不让一条 local-prod 命令撑爆历史', () => {
    const long = `./deploy.sh ${'x'.repeat(2000)}`;
    const value = formatTrackedValue(long, 'strategy.command')!;
    expect(value.length).toBeLessThan(600);
    expect(value.endsWith('（已截断）')).toBe(true);
  });
});

describe('台账上限与落盘', () => {
  it('每个目标的历史条数有上限，超出丢最旧的', () => {
    const store = new ReleaseTargetHistoryStore({ maxPerTarget: 3 });
    for (let i = 0; i < 6; i++) {
      store.append({
        id: `c${i}`,
        targetId: 'tgt-prod',
        projectId: 'proj',
        at: new Date(Date.parse('2026-07-01T00:00:00.000Z') + i * 1000).toISOString(),
        kind: 'updated',
        changes: [],
      });
    }
    const list = store.list('tgt-prod');
    expect(list).toHaveLength(3);
    // 倒序（最新在前）
    expect(list.map((c) => c.id)).toEqual(['c5', 'c4', 'c3']);
  });

  it('默认上限是 MAX_CHANGES_PER_TARGET，不是无限', () => {
    expect(MAX_CHANGES_PER_TARGET).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_CHANGES_PER_TARGET)).toBe(true);
  });

  it('落盘后能重新读回；forget 之后不再占桶', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rt-history-'));
    const storePath = path.join(dir, 'release-target-history.json');
    try {
      const store = new ReleaseTargetHistoryStore({ storePath });
      store.append({
        id: 'c1', targetId: 'tgt-prod', projectId: 'proj',
        at: '2026-07-28T00:00:00.000Z', kind: 'updated', changes: [],
      });
      expect(new ReleaseTargetHistoryStore({ storePath }).list('tgt-prod')).toHaveLength(1);

      // 目标被删掉后必须清账：桶自身有条数上限，但桶的数量没有。
      store.forget('tgt-prod');
      expect(new ReleaseTargetHistoryStore({ storePath }).list('tgt-prod')).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordReleaseTargetUpsert 唯一写入收敛点', () => {
  /** 模拟 StateService：upsert 会把 next 合并进**同一个对象引用**（真实实现就是这样）。 */
  function fakeState(seed?: ReleaseTarget) {
    const store = new Map<string, ReleaseTarget>();
    if (seed) store.set(seed.id, seed);
    return {
      getReleaseTarget: (id: string) => store.get(id),
      upsertReleaseTarget: (next: ReleaseTarget) => {
        const existing = store.get(next.id);
        const merged = { ...existing, ...next, updatedAt: '2026-07-28T10:00:00.000Z' } as ReleaseTarget;
        store.set(next.id, merged);
        return merged;
      },
    };
  }

  it('记录的是落库后真正生效的对象', () => {
    const history = new ReleaseTargetHistoryStore();
    const state = fakeState(target());
    recordReleaseTargetUpsert(
      { state, history },
      { ...target(), ssh: { ...target().ssh!, healthcheckUrl: 'https://prod.example.test/healthz' } },
      { actor: 'user:alice' },
    );
    const [entry] = history.list('tgt-prod');
    expect(entry.kind).toBe('updated');
    expect(entry.actor).toBe('user:alice');
    expect(entry.changes.map((c) => c.path)).toEqual(['ssh.healthcheckUrl']);
  });

  it('落库前快照必须深拷贝，否则 diff 恒为空', () => {
    // 事故值：upsert 就地改写 state 里的同一个对象引用时，浅持有会让 before 和 after
    // 指向同一份数据，diff 永远算出零条 —— 「记了等于没记」的静默失效。
    const history = new ReleaseTargetHistoryStore();
    const stored = target();
    const state = {
      getReleaseTarget: () => stored,
      upsertReleaseTarget: (next: ReleaseTarget) => {
        Object.assign(stored, next);
        return stored;
      },
    };
    recordReleaseTargetUpsert(
      { state, history },
      { ...target(), name: '官网（改名）' },
    );
    const [entry] = history.list('tgt-prod');
    expect(entry.changes.map((c) => c.path)).toEqual(['name']);
    expect(entry.changes[0].before).toBe('官网');
  });

  it('没有任何字段变化的 PATCH 不记流水账', () => {
    const history = new ReleaseTargetHistoryStore();
    const state = fakeState(target());
    recordReleaseTargetUpsert({ state, history }, target());
    expect(history.list('tgt-prod')).toHaveLength(0);
  });

  it('归档带上原因，能回答「为什么下线」', () => {
    const history = new ReleaseTargetHistoryStore();
    const state = fakeState(target());
    recordReleaseTargetUpsert(
      { state, history },
      { ...target(), lifecycle: 'archived', isEnabled: false, isCanonical: false },
      { actor: 'user:bob', reason: '站点迁移到新机房' },
    );
    const [entry] = history.list('tgt-prod');
    expect(entry.kind).toBe('archived');
    expect(entry.reason).toBe('站点迁移到新机房');
  });
});
