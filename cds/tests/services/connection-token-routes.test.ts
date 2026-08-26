import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTION_USE_THROTTLE_MS,
  connectionTokenRequiredScope,
  describeConnectionTokenRoutes,
  shouldRecordConnectionUse,
} from '../../src/services/connection-token-routes.js';

/**
 * 「系统互联」连接长效凭据能到达哪些路由。
 *
 * 这把凭据代表**一个被授权的外部系统**，不是 CDS 的管理员。所以这组用例真正要钉住的
 * 不是「该开的开了」，而是「不该开的一条都没开」——一个只该读验收报告的对端，
 * 不能顺手把报告删了、把项目环境变量读走、把分支停掉。
 */
describe('连接凭据的路由白名单', () => {
  describe('该开的', () => {
    it('Page Agent Bridge 不限方法（它本来就是为这把凭据签发的能力，要下发指令）', () => {
      expect(connectionTokenRequiredScope('POST', '/api/bridge/command/branch-1')).toBe('instance:read');
      expect(connectionTokenRequiredScope('GET', '/api/bridge/state/branch-1')).toBe('instance:read');
      expect(connectionTokenRequiredScope('POST', '/api/bridge/start-session')).toBe('instance:read');
    });

    it('验收报告列表与正文可读（外部知识库镜像报告要用）', () => {
      expect(connectionTokenRequiredScope('GET', '/api/reports')).toBe('instance:read');
      expect(connectionTokenRequiredScope('GET', '/api/reports/rep-123/raw')).toBe('instance:read');
    });

    it('报告 id 里有点、连字符、编码字符也认得出来', () => {
      expect(connectionTokenRequiredScope('GET', '/api/reports/acc-prd-agent-202608261200/raw')).toBe('instance:read');
      expect(connectionTokenRequiredScope('GET', '/api/reports/a.b-c_d/raw')).toBe('instance:read');
    });
  });

  describe('不该开的', () => {
    it('报告只读——建、删、传附件一律不认', () => {
      // 外部系统是读者不是作者。这三条要是漏了，一把「只读授权」就能改 CDS 上的验收记录。
      expect(connectionTokenRequiredScope('POST', '/api/reports')).toBeNull();
      expect(connectionTokenRequiredScope('DELETE', '/api/reports/rep-123')).toBeNull();
      expect(connectionTokenRequiredScope('POST', '/api/reports/assets')).toBeNull();
      expect(connectionTokenRequiredScope('PUT', '/api/reports/rep-123/raw')).toBeNull();
      expect(connectionTokenRequiredScope('PATCH', '/api/reports/rep-123/raw')).toBeNull();
    });

    it('报告详情本身也没开——只给了清单和正文这两条真用得上的', () => {
      // 最小面原则：MAP 只需要列表 + 正文。没人用的就别开着。
      expect(connectionTokenRequiredScope('GET', '/api/reports/rep-123')).toBeNull();
    });

    it('前缀相同但不是报告的路由不能被顺带放行', () => {
      // 判据写成 startsWith('/api/reports') 的话下面这些全会漏出去。
      expect(connectionTokenRequiredScope('GET', '/api/reports-admin')).toBeNull();
      expect(connectionTokenRequiredScope('GET', '/api/reportsomething')).toBeNull();
      expect(connectionTokenRequiredScope('GET', '/api/reports/rep-123/raw/extra')).toBeNull();
      expect(connectionTokenRequiredScope('GET', '/api/reports/rep/1/raw')).toBeNull();
    });

    it('CDS 管理面一条都不开', () => {
      for (const path of [
        '/api/projects',
        '/api/projects/p1/agent-keys',
        '/api/branches',
        '/api/env',
        '/api/cluster/nodes',
        '/api/self-update',
        '/api/factory-reset',
        '/api/cds-system/connections',
      ]) {
        expect(connectionTokenRequiredScope('GET', path), path).toBeNull();
        expect(connectionTokenRequiredScope('POST', path), path).toBeNull();
      }
    });

    it('Bridge 的前缀也不能被模糊匹配放宽', () => {
      expect(connectionTokenRequiredScope('POST', '/api/bridgex/command')).toBeNull();
      expect(connectionTokenRequiredScope('POST', '/api/bridge')).toBeNull();
    });

    it('方法名大小写不影响判定，空方法不放行', () => {
      expect(connectionTokenRequiredScope('get', '/api/reports')).toBe('instance:read');
      expect(connectionTokenRequiredScope('', '/api/reports')).toBeNull();
    });
  });

  it('每条规则都写得出「为什么给」', () => {
    // 表里出现一条说不出理由的规则，就是下一次越权的入口。
    const described = describeConnectionTokenRoutes();
    expect(described.length).toBeGreaterThan(0);
    for (const line of described) {
      expect(line).toMatch(/→ .+：.+/);
    }
  });
});

/**
 * 判据建好了、但没人调用，是本仓库反复栽过的形状（predicate-and-wiring-discipline 形状 2）。
 * 这条守卫钉住鉴权入口真的走这张表，而不是留着原来那句写死的前缀判断。
 */
describe('接线', () => {
  const serverSource = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');

  it('鉴权入口按方法 + 路径查这张表，并用表里返回的 scope 校验', () => {
    expect(serverSource).toContain('connectionTokenRequiredScope(req.method, req.path)');
    expect(serverSource).toContain('connection.scopes.includes(connectionScope)');
  });

  it('原来那句写死的 Bridge 前缀判断已经不在鉴权分支里了', () => {
    // 留着它就是两处判据并存，改一处忘一处（形状 3：判据分裂后漂移）。
    expect(serverSource).not.toContain("if (stateService && req.path.startsWith('/api/bridge/'))");
  });

  it('scope 不再写死成字面量，跟着表走', () => {
    expect(serverSource).not.toContain("connection.scopes.includes('instance:read')");
  });
});

/**
 * 「最近用过」是给人看的存活指示，但每写一次就把整份状态存一遍。
 * 报告只读放开之后，一轮自动刷新会打出几百个请求——不节流就是把一个只读的
 * 定时任务变成每小时几百次整份落盘（Codex review P2）。
 */
describe('最近用过的节流写', () => {
  const now = '2026-08-26T12:00:00.000Z';

  it('从没记过就写一次', () => {
    expect(shouldRecordConnectionUse(undefined, now)).toBe(true);
    expect(shouldRecordConnectionUse(null, now)).toBe(true);
    expect(shouldRecordConnectionUse('', now)).toBe(true);
  });

  it('刚写过就不再写——同一轮里的几百个请求只落一次盘', () => {
    expect(shouldRecordConnectionUse('2026-08-26T11:59:59.000Z', now)).toBe(false);
    expect(shouldRecordConnectionUse('2026-08-26T11:56:00.000Z', now)).toBe(false);
  });

  it('隔得够久了才写', () => {
    expect(shouldRecordConnectionUse('2026-08-26T11:55:00.000Z', now)).toBe(true);
    expect(shouldRecordConnectionUse('2026-08-26T10:00:00.000Z', now)).toBe(true);
  });

  it('认不出来的值当成没记过，不能让它把写入永久卡死', () => {
    expect(shouldRecordConnectionUse('not-a-date', now)).toBe(true);
  });

  it('存了个未来时间也要能自愈', () => {
    // 改过系统时间或多实例时钟不齐时会出现。判据写成「now - last >= 阈值」
    // 而不处理这一支的话，一个未来时间戳会让它永远不再更新。
    expect(shouldRecordConnectionUse('2026-08-27T00:00:00.000Z', now)).toBe(true);
  });

  it('阈值是分钟级，不是秒级也不是天级', () => {
    expect(CONNECTION_USE_THROTTLE_MS).toBeGreaterThanOrEqual(60 * 1000);
    expect(CONNECTION_USE_THROTTLE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('鉴权入口真的走了节流，不是每次都写', () => {
    const src = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');
    const squashed = src.split(/\s+/).join(' ');
    expect(squashed).toContain(
      'if (shouldRecordConnectionUse(connection.lastUsedAt, nowIso)) { stateService.updateCdsConnection(connection.id, { lastUsedAt: nowIso });',
    );
  });
});
