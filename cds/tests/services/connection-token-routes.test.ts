import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONNECTION_USE_THROTTLE_MS,
  connectionTokenRequiredScope,
  describeConnectionTokenRoutes,
  shouldRecordConnectionUse,
} from '../../src/services/connection-token-routes.js';
import { DEFAULT_SCOPES } from '../../src/services/connection/pairing-service.js';

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
      expect(connectionTokenRequiredScope('GET', '/api/reports')).toBe('report:read');
      expect(connectionTokenRequiredScope('GET', '/api/reports/rep-123/raw')).toBe('report:read');
    });

    it('报告 id 里有点、连字符、编码字符也认得出来', () => {
      expect(connectionTokenRequiredScope('GET', '/api/reports/acc-prd-agent-202608261200/raw')).toBe('report:read');
      expect(connectionTokenRequiredScope('GET', '/api/reports/a.b-c_d/raw')).toBe('report:read');
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
      expect(connectionTokenRequiredScope('get', '/api/reports')).toBe('report:read');
      expect(connectionTokenRequiredScope('', '/api/reports')).toBeNull();
    });

    it('报告不许挂在 Bridge 那条范围下面', () => {
      // 这是这组用例里最要紧的一条。把报告并进 instance:read 只需要改一个字符串，
      // 改完所有用例照样绿——因为「能不能读报告」的判定本身没坏，坏的是
      // **一批早就发出去的 token 在主人没再看过授权页的情况下多读到了东西**。
      // 所以这里钉的不是「能读」，是「用的是哪一把」。
      for (const path of ['/api/reports', '/api/reports/rep-123/raw']) {
        expect(connectionTokenRequiredScope('GET', path), path).not.toBe('instance:read');
      }
      // 反过来，Bridge 必须还留在 instance:read 上——顺手把它也挪走就是另一次越权。
      expect(connectionTokenRequiredScope('POST', '/api/bridge/command/b1')).toBe('instance:read');
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
 * 表里写了一个范围，却没有任何一次授权会授予它——那条规则从落地那天起就永远走不到，
 * 而所有用例照样绿（predicate-and-wiring-discipline 形状 8：拿不成立的声明当证据）。
 * 这一组把「表要求的范围」和「授权真会发的范围」钉在一起。
 */
describe('范围要发得出来，也要跟授权页说的一致', () => {
  const ROUTES_TO_CHECK: ReadonlyArray<[string, string]> = [
    ['GET', '/api/reports'],
    ['GET', '/api/reports/rep-1/raw'],
    ['POST', '/api/bridge/command/b1'],
  ];

  it('表里要求的每个范围，默认授权都发得出来', () => {
    for (const [method, path] of ROUTES_TO_CHECK) {
      const scope = connectionTokenRequiredScope(method, path);
      expect(scope, `${method} ${path} 没被表放行`).not.toBeNull();
      expect(DEFAULT_SCOPES, `${method} ${path} 要 ${scope}，但默认授权不发这一项`).toContain(scope);
    }
  });

  it('授权跳转签发时用的也是 DEFAULT_SCOPES，不是手抄的数组', () => {
    // 这一条是上一版真栽过的地方：DEFAULT_SCOPES 加了一项，而 authorize 那里
    // 传的是自己手抄的 `scopes: [...]`，显式值盖过默认值——新加的范围对真正的
    // 授权流程一次都没生效，所有用例照样绿（形状 6：读的不是真正生效的那个值）。
    const source = readFileSync(join(process.cwd(), 'src/routes/cds-system-connections.ts'), 'utf8');
    expect(source).not.toMatch(/scopes:\s*\[\s*'shared-service:deploy'/);
  });

  it('授权页展示的范围是从 DEFAULT_SCOPES 渲染的，不是另抄的一串字面量', () => {
    // 抄一份出来的后果不是报错，是**用户点头同意的清单和真正签发的清单对不上**——
    // 一边加了范围另一边没加，页面上永远少显示一项，没人会发现。
    const source = readFileSync(join(process.cwd(), 'src/routes/cds-system-connections.ts'), 'utf8');
    expect(source).toContain('DEFAULT_SCOPES.join');
    const shown = source.match(/授权范围：([^<]*)</);
    expect(shown, '授权页上找不到「授权范围：」那一行').not.toBeNull();
    expect(shown![1]).not.toMatch(/instance:read|report:read|shared-service:deploy/);
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
