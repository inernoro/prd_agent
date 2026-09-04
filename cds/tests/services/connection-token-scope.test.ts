import { describe, it, expect } from 'vitest';
import {
  connectionTokenRequiredScope,
  describeConnectionTokenRoutes,
} from '../../src/services/connection-token-routes.js';

/**
 * 判据在合并 main 时收敛到了 `connection-token-routes.ts` —— 原来 server.ts 里那张
 * 内联表被同一件事的另一份实现取代了（两条分支各写了一遍，撞在同一段鉴权代码上）。
 *
 * 这个适配器保住本文件全部断言：它逐字复刻 server.ts 里的用法
 * （`const need = connectionTokenRequiredScope(...); connection.scopes.includes(need)`），
 * 所以「测的是不是真在跑的那条路」这件事没有被削弱。写成适配器而不是改写每一条断言，
 * 是为了让下面每个「放行/拒绝」的成对判据原样留下来。
 */
function connectionTokenAllows(scopes: readonly string[] | undefined, method: string, path: string): boolean {
  const need = connectionTokenRequiredScope(method, path);
  return need !== null && (scopes || []).includes(need);
}
import { DEFAULT_SCOPES, backfillReportReadScope } from '../../src/services/connection/pairing-service.js';

/**
 * 系统互联长效 token 的权限边界。
 *
 * ## 修的是什么
 *
 * MAP 的验收报告导入器一直在用这条连接的长效 token 调 CDS 的 `GET /api/reports`
 * 与 `/api/reports/:id/raw`，而 CDS 那边只在 `/api/bridge/*` 上认这个 token——
 * **MAP 侧接好了、CDS 侧没接**，于是同步从来没成功过。这是 predicate-and-wiring-discipline
 * 形状 2 的典型：链路只建了一半，删掉哪一半测试都不会红。
 *
 * ## 这个文件为什么值得写细
 *
 * 放行判据是安全边界。放宽一点点的代价很具体：`/api/reports` 上 GET 是列表、
 * **POST 是新建**，`/api/reports/:id` 上还有 **DELETE**。判据只看路径不看方法的话，
 * 一个「只读」授权顺手就能删掉验收报告。所以下面每条放行都配一条对应的拒绝。
 */

describe('report:read 放行的到底是哪两条', () => {
  const scopes = ['report:read'];

  it('列表与正文两个 GET 放行', () => {
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports')).toBe(true);
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/acc-123/raw')).toBe(true);
  });

  it('方法必须是 GET——同一个路径上的写操作一律拒绝', () => {
    // `/api/reports` 的 POST 是**新建报告**，`/api/reports/:id` 的 DELETE 是删除。
    // 判据不看方法的话，「只读」授权就能建能删。
    expect(connectionTokenAllows(scopes, 'POST', '/api/reports')).toBe(false);
    expect(connectionTokenAllows(scopes, 'DELETE', '/api/reports/acc-123')).toBe(false);
    expect(connectionTokenAllows(scopes, 'PATCH', '/api/reports/acc-123')).toBe(false);
    expect(connectionTokenAllows(scopes, 'PUT', '/api/reports')).toBe(false);
  });

  it('小写方法名也要当 GET 认（Express 给的是大写，但判据不该赌这个）', () => {
    expect(connectionTokenAllows(scopes, 'get', '/api/reports')).toBe(true);
  });

  it('同前缀下的其它端点不搭便车', () => {
    // 「顺手多给一点」是最小权限最常见的破法。导入器只用那两个，就只给那两个。
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/acc-123')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/acc-123/download')).toBe(false);
    expect(connectionTokenAllows(scopes, 'POST', '/api/reports/acc-123/share')).toBe(false);
    expect(connectionTokenAllows(scopes, 'POST', '/api/reports/acc-123/push-to-pr')).toBe(false);
  });

  it('路径要精确匹配，不是前缀匹配', () => {
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports-secret')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/reportsX')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/')).toBe(false);
    // `[^/]+` 而不是 `.+`：后者会让多段路径也过关。
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/a/b/raw')).toBe(false);
  });

  it('report:read 不会顺带打开 CDS 的其它面', () => {
    for (const path of [
      '/api/projects',
      '/api/branches',
      '/api/env',
      '/api/self-update',
      '/api/factory-reset',
      '/api/cds-system/connections',
      '/api/infra/mongodb/backup',
    ]) {
      expect(connectionTokenAllows(scopes, 'GET', path), `${path} 不该被 report:read 放行`).toBe(false);
    }
  });

  it('report:read 不给 Bridge——两个 scope 各管各的', () => {
    expect(connectionTokenAllows(scopes, 'POST', '/api/bridge/command/br-1')).toBe(false);
  });
});

describe('instance:read 的行为一个字都没变', () => {
  const scopes = ['instance:read'];

  it('Bridge 照旧放行，且不限方法（Bridge 本来就要 POST 指令）', () => {
    expect(connectionTokenAllows(scopes, 'POST', '/api/bridge/command/br-1')).toBe(true);
    expect(connectionTokenAllows(scopes, 'GET', '/api/bridge/state/br-1')).toBe(true);
  });

  it('只增加 MAP 所需的 Agent 只读目录与会话日志，不开放项目管理面', () => {
    expect(connectionTokenAllows(scopes, 'GET', '/api/projects/p1/agent-runtime-providers')).toBe(true);
    expect(connectionTokenAllows(scopes, 'GET', '/api/projects/p1/agent-sessions/s1/logs')).toBe(true);
    expect(connectionTokenAllows(scopes, 'GET', '/api/projects')).toBe(false);
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/files')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/projects/p1/agent-requests')).toBe(false);
  });

  it('instance:read 不顺带打开验收报告', () => {
    // 反过来也要成立：不能因为「都是读」就让老 scope 白捡新权限。
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/acc-1/raw')).toBe(false);
  });
});

describe('Agent 会话调用按现有三个范围严格分权', () => {
  it('资源创建与停止只认 shared-service:deploy', () => {
    const scopes = ['shared-service:deploy'];
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions')).toBe(true);
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions/s1/stop')).toBe(true);
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions/s1/messages')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/projects/p1/agent-runtime-providers')).toBe(false);
  });

  it('执行交互只认 deployment:stream', () => {
    const scopes = ['deployment:stream'];
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions/s1/messages')).toBe(true);
    expect(connectionTokenAllows(scopes, 'GET', '/api/projects/p1/agent-sessions/s1/stream')).toBe(true);
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions/s1/tool-approvals/a1')).toBe(true);
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions')).toBe(false);
    expect(connectionTokenAllows(scopes, 'POST', '/api/projects/p1/agent-sessions/s1/stop')).toBe(false);
  });

  it('相似路径、错方法和管理端点不能搭便车', () => {
    const scopes = DEFAULT_SCOPES;
    for (const [method, path] of [
      ['GET', '/api/projects/p1/agent-sessions'],
      ['GET', '/api/projects/p1/agent-sessions/s1'],
      ['POST', '/api/projects/p1/agent-runtime-providers'],
      ['POST', '/api/projects/p1/files'],
      ['GET', '/api/projects/p1/agent-requests'],
      ['POST', '/api/projects/p1/agent-sessions/s1/restart'],
      ['GET', '/api/projects/p1/agent-sessions/s1/stream/extra'],
    ]) {
      expect(connectionTokenAllows(scopes, method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe('没有 scope 就什么都不放行（防判据恒真）', () => {
  it('空 scope / undefined 一律拒绝', () => {
    // 没有这一组，上面所有「放行」的断言在 connectionTokenAllows 恒返回 true 时也会绿。
    for (const scopes of [[], undefined, ['deployment:stream'], ['shared-service:deploy']]) {
      expect(connectionTokenAllows(scopes, 'GET', '/api/reports')).toBe(false);
      expect(connectionTokenAllows(scopes, 'POST', '/api/bridge/command/br-1')).toBe(false);
    }
  });

  it('拼错的 scope 名不算数', () => {
    expect(connectionTokenAllows(['report:reads'], 'GET', '/api/reports')).toBe(false);
    expect(connectionTokenAllows(['reports:read'], 'GET', '/api/reports')).toBe(false);
  });
});

describe('新配对默认就带 report:read', () => {
  it('默认 scope 里有它，否则新连接配好了还是同步不了', () => {
    expect(DEFAULT_SCOPES).toContain('report:read');
    // 原有三个一个都不能少——少了会让已有能力静默消失。
    expect(DEFAULT_SCOPES).toContain('shared-service:deploy');
    expect(DEFAULT_SCOPES).toContain('instance:read');
    expect(DEFAULT_SCOPES).toContain('deployment:stream');
  });

  it('默认 scope 集合真的能开门（判据与常量没有各自漂移）', () => {
    // 这一条把「常量里写了」和「判据认」连起来。只断言常量的话，
    // 判据那边把 scope 名拼成别的样子，测试照样全绿。
    expect(connectionTokenAllows(DEFAULT_SCOPES, 'GET', '/api/reports')).toBe(true);
    expect(connectionTokenAllows(DEFAULT_SCOPES, 'GET', '/api/reports/x/raw')).toBe(true);
    expect(connectionTokenAllows(DEFAULT_SCOPES, 'POST', '/api/bridge/command/b')).toBe(true);
    // 默认 scope 再全，也不该打开写操作。
    expect(connectionTokenAllows(DEFAULT_SCOPES, 'DELETE', '/api/reports/x')).toBe(false);
  });

  it('每条放行规则都写得出「为什么给」，授权页不能只显示机器名', () => {
    const described = describeConnectionTokenRoutes();
    expect(described.length).toBeGreaterThan(0);
    for (const line of described) expect(line).toMatch(/→ .+：.+/);
    // 表里真的存在 report:read 这一档 —— 从判据反推，不是读一份可能漂移的标签表。
    const needed = new Set(
      [['GET', '/api/reports'], ['GET', '/api/reports/x/raw'], ['POST', '/api/bridge/command/b']]
        .map(([m, p]) => connectionTokenRequiredScope(m, p)),
    );
    expect(needed).toContain('report:read');
    expect(needed).toContain('instance:read');
  });
});

describe('存量连接补 report:read：默认不动，必须管理员显式开', () => {
  function fakeState(conns: Array<{ id: string; scopes: string[] }>) {
    const store = conns.map((c) => ({ ...c, scopes: [...c.scopes] }));
    return {
      store,
      getActiveCdsConnections: () => store,
      updateCdsConnection: (id: string, fields: { scopes: string[] }) => {
        const hit = store.find((c) => c.id === id)!;
        hit.scopes = fields.scopes;
        return hit;
      },
    };
  }

  it('**默认什么都不做** —— 不许替用户同意扩大一张已签发的长期令牌', () => {
    // 第一版是每次启动自动补，理由写的是「已有的 scope 严格更宽」。
    // 那个理由被本文件上面那组用例直接推翻：instance:read 只开 /api/bridge/*，
    // 两者都不含读验收报告。所以自动补 = 在用户没重新看过授权页的情况下
    // 扩大了他手上那张票能读到的东西（Codex review P1）。
    const st = fakeState([{ id: 'c1', scopes: ['shared-service:deploy', 'instance:read'] }]);
    expect(backfillReportReadScope(st)).toEqual([]);
    expect(st.store[0].scopes).toEqual(['shared-service:deploy', 'instance:read']);
    expect(backfillReportReadScope(st, {})).toEqual([]);
    expect(backfillReportReadScope(st, { enabled: false })).toEqual([]);
  });

  it('这条正是「已有 scope 并不覆盖新权限」的证明', () => {
    // 把当初那个错误理由写成断言：如果哪天 instance:read 真的覆盖了报告读取，
    // 这条会红，那时候才轮到重新讨论要不要自动补。
    expect(connectionTokenAllows(['shared-service:deploy', 'instance:read'], 'GET', '/api/reports')).toBe(false);
  });

  it('显式开了才补：缺的补上，已有的不动', () => {
    const st = fakeState([
      { id: 'c1', scopes: ['shared-service:deploy', 'instance:read', 'deployment:stream'] },
      { id: 'c2', scopes: ['instance:read', 'report:read'] },
    ]);
    const patched = backfillReportReadScope(st, { enabled: true });
    expect(patched).toEqual(['c1']);
    expect(st.store[0].scopes).toContain('report:read');
    // 原有 scope 一个都不能丢。
    expect(st.store[0].scopes).toContain('shared-service:deploy');
    expect(st.store[1].scopes).toEqual(['instance:read', 'report:read']);
  });

  it('幂等：开着再跑一次什么都不改', () => {
    const st = fakeState([{ id: 'c1', scopes: ['instance:read'] }]);
    expect(backfillReportReadScope(st, { enabled: true })).toEqual(['c1']);
    expect(backfillReportReadScope(st, { enabled: true })).toEqual([]);
    expect(st.store[0].scopes.filter((s) => s === 'report:read')).toHaveLength(1);
  });

  it('补完之后判据真的放行（端到端，不只是数组里多了个字符串）', () => {
    const st = fakeState([{ id: 'c1', scopes: ['instance:read'] }]);
    expect(connectionTokenAllows(st.store[0].scopes, 'GET', '/api/reports')).toBe(false);
    backfillReportReadScope(st, { enabled: true });
    expect(connectionTokenAllows(st.store[0].scopes, 'GET', '/api/reports')).toBe(true);
    // 补的是窄权限，不是万能钥匙。
    expect(connectionTokenAllows(st.store[0].scopes, 'DELETE', '/api/reports/x')).toBe(false);
  });

  it('只动 active 的——revoked 连接由 getActiveCdsConnections 挡在外面', () => {
    const st = fakeState([]);
    expect(backfillReportReadScope(st, { enabled: true })).toEqual([]);
  });
});
