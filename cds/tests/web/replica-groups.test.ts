/**
 * 项目级整组按持久化组身份 join 的契约（Codex 第二十轮 P1）：
 * 各 profile 成员数组错位（部分失败/单侧下线）时不再按位拼假组；
 * 无 projectGroupId 的存量成员按位兜底，且与 id 组互不混淆。
 */
import { describe, expect, it } from 'vitest';
import { buildProjectGroups, newProjectGroupId } from '../../web/src/lib/replicaGroups.js';

type M = { id: string; projectGroupId?: string; createdAt?: string };

describe('buildProjectGroups', () => {
  it('按 projectGroupId join：数组错位时不按位拼假组', () => {
    // api 有两组成员（pg1 在前），web 只有 pg2 成功（pg1 那次 web 侧失败被删）
    const members: Record<string, M[]> = {
      api: [
        { id: 'res-1', projectGroupId: 'pg1', createdAt: '2026-07-27T01:00:00Z' },
        { id: 'res-2', projectGroupId: 'pg2', createdAt: '2026-07-27T02:00:00Z' },
      ],
      web: [
        { id: 'res-1', projectGroupId: 'pg2', createdAt: '2026-07-27T02:00:01Z' },
      ],
    };
    const groups = buildProjectGroups(['api', 'web'], (pid) => members[pid] ?? []);
    expect(groups).toHaveLength(2);
    // pg1 组：只有 api 成员，web 缺口显式为 undefined（不许把 web 的 pg2 成员错配进来）
    const g1 = groups.find((g) => g.api?.projectGroupId === 'pg1')!;
    expect(g1.web).toBeUndefined();
    // pg2 组：api res-2 与 web res-1 正确配对（按位配对会把 web res-1 错配给 api res-1）
    const g2 = groups.find((g) => g.api?.projectGroupId === 'pg2')!;
    expect(g2.api?.id).toBe('res-2');
    expect(g2.web?.id).toBe('res-1');
  });

  it('存量无组 id 成员按位兜底，且排在 id 组之前、互不混淆', () => {
    const members: Record<string, M[]> = {
      api: [
        { id: 'res-1' },
        { id: 'res-2', projectGroupId: 'pgx', createdAt: '2026-07-27T03:00:00Z' },
      ],
      web: [{ id: 'res-1' }],
    };
    const groups = buildProjectGroups(['api', 'web'], (pid) => members[pid] ?? []);
    expect(groups).toHaveLength(2);
    expect(groups[0].api?.id).toBe('res-1');
    expect(groups[0].web?.id).toBe('res-1');
    expect(groups[1].api?.id).toBe('res-2');
    expect(groups[1].web).toBeUndefined();
  });

  it('id 组按最早 createdAt 升序稳定排序', () => {
    const members: Record<string, M[]> = {
      api: [
        { id: 'res-2', projectGroupId: 'later', createdAt: '2026-07-27T05:00:00Z' },
        { id: 'res-1', projectGroupId: 'earlier', createdAt: '2026-07-27T04:00:00Z' },
      ],
    };
    const groups = buildProjectGroups(['api'], (pid) => members[pid] ?? []);
    expect(groups.map((g) => g.api?.projectGroupId)).toEqual(['earlier', 'later']);
  });

  it('newProjectGroupId 形态合法且可通过后端白名单校验', () => {
    const id = newProjectGroupId();
    expect(/^[a-zA-Z0-9_-]{1,40}$/.test(id)).toBe(true);
  });
});
