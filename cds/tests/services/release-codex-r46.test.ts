/**
 * Codex 第 46 轮三条 review 的回归（PR #1281）。
 *
 * 三条的共性值得记：**都不是逻辑写错，都是「判据比它该管的范围窄」**。
 *  - P1 用裸字符串比较当「同一个目录」的判据 —— 窄在没规范化；
 *  - P2 用条数与时间窗当「这条预检还有没有用」的判据 —— 窄在没看引用；
 *  - P2 后端算出了归因却没有前端消费 —— 窄在链路只建到一半。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSameRemoteDirectory,
  normalizeRemoteDirectoryIdentity,
} from '../../src/services/release-artifact-retention.js';
import { selectReleasePreflightsToPrune } from '../../src/services/release-retention.js';
import type { ReleasePreflightRecord } from '../../src/types.js';

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
