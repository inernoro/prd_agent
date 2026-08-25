import { describe, it, expect } from 'vitest';
import { connectionTokenAllows, connectionScopeLabels } from '../../src/server.js';
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

  it('instance:read 不顺带打开验收报告', () => {
    // 反过来也要成立：不能因为「都是读」就让老 scope 白捡新权限。
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports')).toBe(false);
    expect(connectionTokenAllows(scopes, 'GET', '/api/reports/acc-1/raw')).toBe(false);
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

  it('每个 scope 都有人话说明，授权页不能只显示机器名', () => {
    const labels = connectionScopeLabels();
    expect(labels.map((l) => l.scope)).toContain('report:read');
    for (const l of labels) expect(l.label.length).toBeGreaterThan(0);
  });
});

describe('存量连接补 report:read', () => {
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

  it('缺的补上，已有的不动', () => {
    // 不补的话：判据加好了、默认 scope 也加好了，但线上**已经配好的那条连接**
    // 里没有这个 scope，同步照样 401——「修了像没修」。
    const st = fakeState([
      { id: 'c1', scopes: ['shared-service:deploy', 'instance:read', 'deployment:stream'] },
      { id: 'c2', scopes: ['instance:read', 'report:read'] },
    ]);
    const patched = backfillReportReadScope(st);
    expect(patched).toEqual(['c1']);
    expect(st.store[0].scopes).toContain('report:read');
    // 原有 scope 一个都不能丢。
    expect(st.store[0].scopes).toContain('shared-service:deploy');
    expect(st.store[1].scopes).toEqual(['instance:read', 'report:read']);
  });

  it('幂等：再跑一次什么都不改', () => {
    const st = fakeState([{ id: 'c1', scopes: ['instance:read'] }]);
    expect(backfillReportReadScope(st)).toEqual(['c1']);
    expect(backfillReportReadScope(st)).toEqual([]);
    // 补两次不该出现两个 report:read。
    expect(st.store[0].scopes.filter((s) => s === 'report:read')).toHaveLength(1);
  });

  it('补完之后判据真的放行（端到端，不只是数组里多了个字符串）', () => {
    const st = fakeState([{ id: 'c1', scopes: ['instance:read'] }]);
    expect(connectionTokenAllows(st.store[0].scopes, 'GET', '/api/reports')).toBe(false);
    backfillReportReadScope(st);
    expect(connectionTokenAllows(st.store[0].scopes, 'GET', '/api/reports')).toBe(true);
    // 补的是窄权限，不是万能钥匙。
    expect(connectionTokenAllows(st.store[0].scopes, 'DELETE', '/api/reports/x')).toBe(false);
  });

  it('只动 active 的——revoked 连接由 getActiveCdsConnections 挡在外面', () => {
    // 判据取的是「active 列表」，撤销过的连接压根不在里面。
    // 这条断言的是接线口径：换成 getCdsConnections() 会把已撤销的也复活成可用。
    const st = fakeState([]);
    expect(backfillReportReadScope(st)).toEqual([]);
  });
});
