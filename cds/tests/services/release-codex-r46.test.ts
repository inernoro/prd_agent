/**
 * Codex 第 46 轮三条 review 的回归（PR #1281）。
 *
 * 三条的共性值得记：**都不是逻辑写错，都是「判据比它该管的范围窄」**。
 *  - P1 用裸字符串比较当「同一个目录」的判据 —— 窄在没规范化；
 *  - P2 用条数与时间窗当「这条预检还有没有用」的判据 —— 窄在没看引用；
 *  - P2 后端算出了归因却没有前端消费 —— 窄在链路只建到一半。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSameRemoteDirectory,
  normalizeRemoteDirectoryIdentity,
} from '../../src/services/release-artifact-retention.js';
import { canReuseReleasePreflight, selectReleasePreflightsToPrune } from '../../src/services/release-retention.js';
import { formatTrackedValue, releaseTargetConfigFingerprint } from '../../src/services/release-target-history.js';
import { computeReleaseDora, type ReleaseDoraRunLike } from '../../src/services/release-dora.js';
import {
  readReleaseHealthSnapshot,
  setReleaseHealthSource,
} from '../../src/services/release-health-snapshot.js';
import type { ReleasePreflightRecord, ReleaseTarget } from '../../src/types.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('P1 共用目录判据必须规范化后再比', () => {
  it('尾斜杠 / 重复分隔符 / . / .. 都算同一个目录', () => {
    // 事故值：`a.trim() === b.trim()`。`/opt/site` 与 `/opt/site/` 被判为不共用，
    // 于是共用保护被关掉，回收把另一个目标台账里的成品当孤儿删掉 —— 砍到别人的生产。
    for (const [a, b] of [
      ['/opt/site', '/opt/site/'],
      ['/opt/site', '/opt//site'],
      ['/opt/site', '/opt/site/.'],
      ['/opt/site', '/opt/x/../site'],
      ['/opt/site/', '  /opt/site  '],
    ] as Array<[string, string]>) {
      expect(isSameRemoteDirectory(a, b)).toBe(true);
    }
  });

  it('真正不同的目录不许被误判成共用（保护不能反向误伤）', () => {
    for (const [a, b] of [
      ['/opt/site', '/opt/site2'],
      ['/opt/site', '/opt/site/sub'],
      ['/opt/site', '/Opt/site'],
      ['../a', 'a'],
    ] as Array<[string, string]>) {
      expect(isSameRemoteDirectory(a, b)).toBe(false);
    }
  });

  it('空路径不构成共用（否则所有未配目录的目标会被互相绑定）', () => {
    expect(isSameRemoteDirectory('', '')).toBe(false);
    expect(isSameRemoteDirectory('  ', '/opt/site')).toBe(false);
  });

  it('绝对路径在根部吃掉多余的 ..，相对路径必须保留', () => {
    expect(normalizeRemoteDirectoryIdentity('/../../opt/site')).toBe('/opt/site');
    expect(normalizeRemoteDirectoryIdentity('../a')).toBe('../a');
    expect(normalizeRemoteDirectoryIdentity('a/b/../c')).toBe('a/c');
  });

  it('共用判定只有一处实现，release-service 不许再写第二份比较', () => {
    const service = fs.readFileSync(path.join(CDS_ROOT, 'src/services/release-service.ts'), 'utf8');
    expect(service).toContain('isSameRemoteDirectory(');
    // 事故写法：把两个 publicDirectory trim 完直接 === 。
    expect(service).not.toMatch(/publicDirectory\s*\|\|\s*''\)\.trim\(\)\s*===\s*publicDirectory/);
  });
});

describe('P2 预检裁剪必须保住被 run 引用的那些', () => {
  function record(id: string, createdAt: string): ReleasePreflightRecord {
    return { id, targetId: 'target-prod', createdAt, ok: true, checks: [] } as unknown as ReleasePreflightRecord;
  }

  /** 40 条，最旧的那条被一个仍在保留的 run 引用着。 */
  const records = Array.from({ length: 40 }, (_, i) =>
    record(`pf_${String(i).padStart(3, '0')}`, `2026-07-28T${String(i % 24).padStart(2, '0')}:00:00.000Z`));

  it('被引用的记录不进淘汰名单，哪怕它是最旧的一条', () => {
    // 事故值：只按条数与时间窗裁剪。同一目标再做 20 次预检就能把在途 run
    // 依据的结论删掉，run 上的审计链接指向空气 —— 而这正是预检落库的全部意义。
    const doomed = selectReleasePreflightsToPrune({
      records,
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxPerTarget: 20,
      referencedIds: ['pf_000'],
    });

    expect(doomed).not.toContain('pf_000');
    expect(doomed.length).toBeGreaterThan(0);
  });

  it('被引用的记录不占淘汰名额，否则条数上限形同虚设', () => {
    // 若引用集参与 overflow 计数，它们会把 overflow 顶着不动，
    // 结果是「保护了 5 条」变成「另外 5 条可删的也活下来」。
    const referenced = ['pf_000', 'pf_001', 'pf_002', 'pf_003', 'pf_004'];
    const doomed = selectReleasePreflightsToPrune({
      records,
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxPerTarget: 20,
      retentionMs: 0,
      referencedIds: referenced,
    });

    // 未被引用的共 35 条，上限 20 → 应删 15 条，与被保护的 5 条无关。
    expect(doomed).toHaveLength(15);
    for (const id of referenced) expect(doomed).not.toContain(id);
  });

  it('不传 referencedIds 时行为与之前一致（存量调用方不受影响）', () => {
    const doomed = selectReleasePreflightsToPrune({
      records,
      nowMs: Date.parse('2026-07-28T12:00:00.000Z'),
      maxPerTarget: 20,
      retentionMs: 0,
    });
    expect(doomed).toHaveLength(20);
  });
});

describe('P2 故障归因必须在状态页可见', () => {
  const statusPage = fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/StatusPage.tsx'), 'utf8');

  it('前端 incident 类型声明了归因字段并真的渲染出来', () => {
    // 事故值：后端 uptime API 一直返回 releaseId / releaseAgeMs，前端既没声明也没渲染，
    // 全仓搜不到任何 web 侧消费者 —— 能力记录了但用户答不出「是哪次发布引入的」。
    expect(statusPage).toContain('releaseId?: string');
    expect(statusPage).toContain('releaseAgeMs?: number');
    expect(statusPage).toContain('incident.releaseId');
    expect(statusPage).toContain('incident.releaseAgeMs');
  });

  it('归因文案是「疑似」，不把时间相邻说成因果', () => {
    expect(statusPage).toContain('疑似 ');
  });
});

describe('P2 自动恢复必须计入恢复时长', () => {
  function run(over: Partial<ReleaseDoraRunLike> & { releaseId: string }): ReleaseDoraRunLike {
    return { targetId: 'target-prod', status: 'success', startedAt: '', ...over };
  }

  /**
   * 真实时序（这一段是本套件最重要的东西）：
   *   probeReleaseSurface 抛错 → restorePreviousAfterFailedProbe 落 autoRestoreStartedAt
   *   → 恢复成功落 autoRestoredAt → throw err 冒泡 → failRun 才写 finishedAt。
   * 所以 **autoRestoredAt 恒早于 finishedAt**。
   *
   * 上一版用例把 autoRestoredAt 写成晚于 finishedAt，那个顺序现实中不可能出现；
   * 于是用例绿着，而生产里 `autoRestoredAt >= failure.at` 恒为 false，整条修复空转。
   * 这是「测试编码了作者的假设而不是真实时序」的教科书案例，比没有测试更糟 ——
   * 它让人以为这件事已经验过了。
   */
  const REAL_ORDER = {
    startedAt: '2026-07-28T10:00:00.000Z',
    autoRestoreStartedAt: '2026-07-28T10:04:00.000Z',
    autoRestoredAt: '2026-07-28T10:04:45.000Z',
    finishedAt: '2026-07-28T10:05:00.000Z',
  };

  it('按真实时序（恢复早于 finishedAt）仍算恢复，时长取探测失败到恢复完成', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'rel_fail', status: 'failed', ...REAL_ORDER }),
    ], { nowMs: Date.parse('2026-07-28T12:00:00.000Z'), windowDays: 30 });

    expect(metrics.recovery.ongoingCount).toBe(0);
    expect(metrics.recovery.sampleCount).toBe(1);
    // 45s = autoRestoredAt - autoRestoreStartedAt，不是与 finishedAt 的差（那会是负数）。
    expect(metrics.recovery.p50Ms).toBe(45_000);
  });

  it('存量 run 只有 autoRestoredAt、没有起点时：算已恢复，但时长未知不进样本', () => {
    // 事故值：起点缺失时退回 finishedAt（更晚）→ 差值为负 → 夹成 0 →
    // 「未知时长」被当成「瞬时恢复」，p50/p90 被系统性压低，
    // 也违背本模块「绝不编造 0」的口径（Codex P2 第三轮）。
    const metrics = computeReleaseDora([
      run({
        releaseId: 'rel_fail',
        status: 'failed',
        startedAt: REAL_ORDER.startedAt,
        autoRestoredAt: REAL_ORDER.autoRestoredAt,
        finishedAt: REAL_ORDER.finishedAt,
      }),
    ], { nowMs: Date.parse('2026-07-28T12:00:00.000Z'), windowDays: 30 });

    expect(metrics.recovery.ongoingCount).toBe(0);
    expect(metrics.recovery.recoveredUnknownDurationCount).toBe(1);
    // 关键：不进样本，更不能是 0。
    expect(metrics.recovery.sampleCount).toBe(0);
    expect(metrics.recovery.p50Ms).toBeNull();
  });

  it('没有自动恢复也没有后续成功发布时，仍如实算进行中故障', () => {
    const metrics = computeReleaseDora([
      run({
        releaseId: 'rel_fail',
        status: 'failed',
        startedAt: REAL_ORDER.startedAt,
        finishedAt: REAL_ORDER.finishedAt,
      }),
    ], { nowMs: Date.parse('2026-07-28T12:00:00.000Z'), windowDays: 30 });

    expect(metrics.recovery.ongoingCount).toBe(1);
    expect(metrics.recovery.sampleCount).toBe(0);
  });

  it('样本数与进行中数之和恒等于失败数（不会有失败既不算恢复也不算进行中）', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'rel_a', status: 'failed', ...REAL_ORDER }),
      run({ releaseId: 'rel_b', status: 'failed', startedAt: REAL_ORDER.startedAt, finishedAt: REAL_ORDER.finishedAt }),
      run({
        releaseId: 'rel_c',
        status: 'failed',
        startedAt: REAL_ORDER.startedAt,
        finishedAt: REAL_ORDER.finishedAt,
        // 时钟回拨造成的脏数据：恢复时刻早于起点。
        autoRestoreStartedAt: '2026-07-28T10:04:00.000Z',
        autoRestoredAt: '2026-07-28T09:00:00.000Z',
      }),
    ], { nowMs: Date.parse('2026-07-28T12:00:00.000Z'), windowDays: 30 });

    expect(metrics.changeFailure.failed).toBe(3);
    // 三者之和恒等于失败数：已恢复且知道时长 / 已恢复但时长未知 / 仍在进行中。
    // 少任何一类都会出现「某条失败凭空消失」或「被重复计两次」。
    expect(
      metrics.recovery.sampleCount
      + metrics.recovery.ongoingCount
      + metrics.recovery.recoveredUnknownDurationCount,
    ).toBe(3);
    // 时钟回拨那条进「时长未知」，不产生 0 样本也不产生负数。
    expect(metrics.recovery.recoveredUnknownDurationCount).toBe(1);
    expect(metrics.recovery.p50Ms).toBe(45_000);
  });

  it('源码守卫：配对不许再拿 autoRestoredAt 与 failure.at 比大小', () => {
    // 事故写法恒为 false，删掉它不会红任何行为用例（当时的用例用的是假时序）。
    const dora = fs.readFileSync(path.join(CDS_ROOT, 'src/services/release-dora.ts'), 'utf8');
    expect(dora).toContain('autoRestoreStartedAt');
    // 必须剥注释再扫：解释「为什么不能这么写」的注释里会原样出现事故写法，
    // 不剥的话守卫会被自己的说明文字触发（本 session 第二次踩同一个坑）。
    const code = dora.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/autoRestoredAt\s*>=\s*failure\.at/);
  });
});

describe('P2 监控关闭时发布中心必须说实话', () => {
  const target = {
    id: 'rt_1',
    type: 'ssh' as const,
    isEnabled: true,
    ssh: { healthcheckUrl: 'https://prod.example.test/health' },
  } as unknown as Parameters<typeof readReleaseHealthSnapshot>[0];

  afterEach(() => setReleaseHealthSource(null));

  it('传了关闭原因时如实报出来，不再说「稍后自动开始探测」', () => {
    // 事故值：监控关掉后 source 照常注册但记录永远建不出来，健康列永久显示
    // 「稍后自动开始探测」——一个不会兑现的承诺，而实时探测已经拿掉了。
    setReleaseHealthSource(null, '存活监控已按 CDS_UPTIME_ENABLED=0 关闭，发布中心没有生产健康数据来源');
    const health = readReleaseHealthSnapshot(target);
    expect(health.status).toBe('unknown');
    expect(health.message).toContain('CDS_UPTIME_ENABLED=0');
    expect(health.message).not.toContain('稍后自动开始探测');
  });

  it('bootstrap 在两个开关任一关闭时都不注册 source', () => {
    const index = fs.readFileSync(path.join(CDS_ROOT, 'src/index.ts'), 'utf8');
    expect(index).toContain('CDS_UPTIME_ENABLED=0');
    expect(index).toContain('CDS_UPTIME_RELEASE_ENABLED=0');
    expect(index).toContain('setReleaseHealthSource(null, releaseProbeDisabledReason)');
  });
});

describe('P1 预检复用必须绑定目标配置指纹', () => {
  const base = {
    id: 'rt_1',
    projectId: 'p1',
    name: '生产站点',
    type: 'ssh' as const,
    isEnabled: true,
    strategy: { mode: 'existing-script' as const, command: './deploy.sh' },
    ssh: {
      host: 'prod.example.test',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-a',
      appPath: '/srv/app',
      deployCommand: './deploy.sh',
      healthcheckUrl: 'https://prod.example.test/health',
    },
  } as unknown as ReleaseTarget;

  function withSsh(over: Record<string, unknown>): ReleaseTarget {
    return { ...base, ssh: { ...(base as { ssh: object }).ssh, ...over } } as ReleaseTarget;
  }

  it('配置没动时指纹稳定（否则每次发布都白跑一次预检）', () => {
    expect(releaseTargetConfigFingerprint(base)).toBe(releaseTargetConfigFingerprint({ ...base } as ReleaseTarget));
  });

  it('任一可审计字段变了，指纹就变', () => {
    // 事故值：复用键只有 targetId。运维在两分钟复用窗口里换了机器 / 凭据 / 目录 /
    // 脚本 / 健康地址，键照样命中，旧结论被套到从没验证过的目标上。
    const mutations: Array<[string, ReleaseTarget]> = [
      ['host', withSsh({ host: 'other.example.test' })],
      ['privateKeyRef', withSsh({ privateKeyRef: 'host-b' })],
      ['appPath', withSsh({ appPath: '/srv/other' })],
      ['deployCommand', withSsh({ deployCommand: './other.sh' })],
      ['healthcheckUrl', withSsh({ healthcheckUrl: 'https://other.example.test/health' })],
      ['port', withSsh({ port: 2222 })],
      ['strategy.command', { ...base, strategy: { mode: 'existing-script', command: './other.sh' } } as ReleaseTarget],
    ];
    for (const [label, mutated] of mutations) {
      expect(`${label}:${releaseTargetConfigFingerprint(mutated)}`)
        .not.toBe(`${label}:${releaseTargetConfigFingerprint(base)}`);
    }
  });

  it('指纹不含凭据引用原值（历史/记录的读权限比目标本身宽）', () => {
    expect(releaseTargetConfigFingerprint(base)).not.toContain('host-a');
  });

  it('指纹对不上就不许复用', () => {
    const record = {
      id: 'pf_1',
      projectId: 'p1',
      branchId: 'b1',
      targetId: 'rt_1',
      ok: true,
      checks: [],
      artifactCommitSha: 'a'.repeat(40),
      targetConfigFingerprint: releaseTargetConfigFingerprint(base),
      projectIdentityFingerprint: 'pid:aaaaaaaaaaaa',
      createdAt: '2026-07-28T10:00:00.000Z',
    } as unknown as ReleasePreflightRecord;
    const nowMs = Date.parse('2026-07-28T10:00:30.000Z');
    const key = {
      branchId: 'b1',
      targetId: 'rt_1',
      commitSha: 'a'.repeat(40),
      targetConfigFingerprint: releaseTargetConfigFingerprint(base),
      projectIdentityFingerprint: 'pid:aaaaaaaaaaaa',
    };

    expect(canReuseReleasePreflight(record, key, nowMs)).toBe(true);
    expect(canReuseReleasePreflight(record, {
      ...key,
      targetConfigFingerprint: releaseTargetConfigFingerprint(withSsh({ host: 'other.example.test' })),
    }, nowMs)).toBe(false);
    // 目标一个字节没动、但项目换了仓库（PUT /projects/:id 改 gitRepoUrl）也必须重跑：
    // 复用路径不会重跑 project-identity / remote-repository 两项检查（Codex P1 第三轮）。
    expect(canReuseReleasePreflight(record, {
      ...key,
      projectIdentityFingerprint: 'pid:bbbbbbbbbbbb',
    }, nowMs)).toBe(false);
  });

  it('存量记录没有指纹字段时一律重跑，不盲信', () => {
    const legacy = {
      id: 'pf_legacy',
      projectId: 'p1',
      branchId: 'b1',
      targetId: 'rt_1',
      ok: true,
      checks: [],
      artifactCommitSha: 'a'.repeat(40),
      createdAt: '2026-07-28T10:00:00.000Z',
    } as unknown as ReleasePreflightRecord;

    expect(canReuseReleasePreflight(legacy, {
      branchId: 'b1',
      targetId: 'rt_1',
      commitSha: 'a'.repeat(40),
      targetConfigFingerprint: releaseTargetConfigFingerprint(base),
      projectIdentityFingerprint: 'pid:aaaaaaaaaaaa',
    }, Date.parse('2026-07-28T10:00:30.000Z'))).toBe(false);
  });

  it('指纹清单直接复用变更历史那张表，不另立第二份', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/services/release-target-history.ts'), 'utf8');
    // 两张表漂移的后果最危险的方向是：历史记了一笔变更，预检却认为配置没变照旧复用。
    expect(source).toMatch(/releaseTargetConfigFingerprint[\s\S]{0,400}RELEASE_TARGET_TRACKED_PATHS/);
  });
});

describe('Codex 第三轮：指纹必须建在原值上，复用必须刷新上一版本', () => {
  const long = 'x'.repeat(600);
  const withCommand = (command: string): ReleaseTarget => ({
    id: 'rt_1',
    projectId: 'p1',
    name: 's',
    type: 'ssh',
    isEnabled: true,
    strategy: { mode: 'existing-script', command },
    ssh: {
      host: 'h', port: 22, user: 'u', privateKeyRef: 'k',
      appPath: '/srv/app', deployCommand: command, healthcheckUrl: 'https://h/health',
    },
  } as unknown as ReleaseTarget);

  it('超过展示截断长度之后的差异照样改变指纹', () => {
    // 事故值：指纹建在 formatTrackedValue 上，512 字之后被截断，
    // 两条只在尾部不同的长发布命令算出同一个指纹 —— 命令换了却照旧放行。
    const a = releaseTargetConfigFingerprint(withCommand(`${long}A`));
    const b = releaseTargetConfigFingerprint(withCommand(`${long}B`));
    expect(a).not.toBe(b);
  });

  it('只改敏感参数（TOKEN=）也必须改变指纹', () => {
    // 事故值：展示层把 TOKEN=xxx 统一掩码，两个不同 token 掩码后完全相同。
    const a = releaseTargetConfigFingerprint(withCommand('./deploy.sh TOKEN=aaaaaaaaaaaa'));
    const b = releaseTargetConfigFingerprint(withCommand('./deploy.sh TOKEN=bbbbbbbbbbbb'));
    expect(a).not.toBe(b);
  });

  it('指纹是单向哈希，不残留任何明文', () => {
    const fp = releaseTargetConfigFingerprint(withCommand('./deploy.sh TOKEN=supersecret'));
    expect(fp).not.toContain('supersecret');
    expect(fp).not.toContain('deploy.sh');
    expect(fp).toMatch(/^ref:[0-9a-f]{12}$/);
  });

  it('展示层仍然脱敏 + 截断（两条路分工没被搞混）', () => {
    expect(formatTrackedValue('./deploy.sh TOKEN=supersecret', 'strategy.command'))
      .not.toContain('supersecret');
    expect(formatTrackedValue(`${long}A`, 'strategy.command')).toContain('已截断');
  });

  it('源码守卫：指纹不许再走展示格式化函数', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/services/release-target-history.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const fnStart = code.indexOf('export function releaseTargetConfigFingerprint');
    const fnEnd = code.indexOf('export function formatTrackedValue');
    const body = code.slice(fnStart, fnEnd);
    expect(body).toContain('rawTrackedValue(');
    expect(body).not.toContain('formatTrackedValue(');
  });

  it('源码守卫：复用时上一成功版本必须现取，不许还原落库那份', () => {
    const source = fs.readFileSync(path.join(CDS_ROOT, 'src/services/release-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    // 事故写法：previousRelease 从 record.previousReleaseId 还原 —— TTL 内另一条发布
    // 刚成功时，新 run 会跳过那个最新版本，自动恢复推更旧的版本上生产。
    expect(code).not.toMatch(/previousRelease:\s*record\.previousReleaseId/);
    expect(code).toContain('previousRelease: this.stateService.getLatestSuccessfulReleaseRun(target.id)');
  });
});
