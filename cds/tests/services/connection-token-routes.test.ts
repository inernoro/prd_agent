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

    it('只按真实 MAP 调用所需范围开放 Agent 目录与会话链路', () => {
      const project = 'prd-agent';
      const session = 'cds-agent-123';
      expect(connectionTokenRequiredScope('GET', `/api/projects/${project}/agent-runtime-providers`))
        .toBe('instance:read');
      expect(connectionTokenRequiredScope('POST', `/api/projects/${project}/agent-sessions`))
        .toBe('shared-service:deploy');
      expect(connectionTokenRequiredScope('POST', `/api/projects/${project}/agent-sessions/${session}/messages`))
        .toBe('deployment:stream');
      expect(connectionTokenRequiredScope('GET', `/api/projects/${project}/agent-sessions/${session}/stream`))
        .toBe('deployment:stream');
      expect(connectionTokenRequiredScope('POST', `/api/projects/${project}/agent-sessions/${session}/tool-approvals/a-1`))
        .toBe('deployment:stream');
      expect(connectionTokenRequiredScope('POST', `/api/projects/${project}/agent-sessions/${session}/stop`))
        .toBe('shared-service:deploy');
      expect(connectionTokenRequiredScope('GET', `/api/projects/${project}/agent-sessions/${session}/logs`))
        .toBe('instance:read');
      // 停止返回旧式无结构 400 时 MAP 要回读这一条会话，分清「已经没了」与「真失败」。
      // 这条最初在拒绝名单里、理由写的是「未被 MAP 使用的旁路」——回读落地后那个前提就不成立了
      //（Codex P2，2026-09-15）。放行的是单条只读，路由自身仍只给调用方自己的会话。
      expect(connectionTokenRequiredScope('GET', `/api/projects/${project}/agent-sessions/${session}`))
        .toBe('instance:read');
      // OpenDesign 创建必然是 202（容器后台起），MAP 只能按自己的 clientRequestId 回查才知道
      // 建成了哪一份运行时。这条同样曾在拒绝名单里、理由也写的是「未被 MAP 使用的旁路」，
      // 而 MAP 的 202 恢复路径用的正是它——同一个前提连错两次（Codex P1，2026-09-15）。
      expect(connectionTokenRequiredScope('GET', `/api/projects/${project}/agent-sessions`, { clientRequestId: 'req-1' }))
        .toBe('instance:read');
    });

    it('会话回查必须带 clientRequestId，缺了就不是回查而是整份清单', () => {
      // 处理器把缺省的查询值当成「不过滤」，所以只按路径放行等于把这把凭据名下的
      // 全部会话与预约（clientUser、模型端点、工作区、仓库、容器、运行时元数据）
      // 一起开出去。上一版只把这件事写进了注释（Codex P2，2026-09-15）。
      const listPath = '/api/projects/f9e8b956d3dd/agent-sessions';
      expect(connectionTokenRequiredScope('GET', listPath)).toBeNull();
      expect(connectionTokenRequiredScope('GET', listPath, {})).toBeNull();
      expect(connectionTokenRequiredScope('GET', listPath, { clientRequestId: '   ' })).toBeNull();
      expect(connectionTokenRequiredScope('GET', listPath, { clientRequestId: ['a', 'b'] })).toBeNull();
      // 别的查询参数凑不出这条放行。
      expect(connectionTokenRequiredScope('GET', listPath, { projectId: 'p1' })).toBeNull();
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
        '/api/projects/p1/files',
        '/api/projects/p1/agent-runtime-capacity',
        '/api/projects/p1/agent-requests',
      ]) {
        expect(connectionTokenRequiredScope('GET', path), path).toBeNull();
        expect(connectionTokenRequiredScope('POST', path), path).toBeNull();
      }
    });

    it('Agent 白名单不接受错方法、多余层级或未被 MAP 使用的旁路', () => {
      const base = '/api/projects/p1/agent-sessions/s1';
      for (const [method, path] of [
        ['POST', '/api/projects/p1/agent-runtime-providers'],
        ['GET', `${base}/messages`],
        ['POST', `${base}/stream`],
        ['GET', `${base}/tool-approvals/a1`],
        ['POST', `${base}/logs`],
        ['DELETE', `${base}/stop`],
        ['GET', `${base}/stream/extra`],
        ['POST', `${base}/tool-approvals/a1/extra`],
        ['POST', '/api/projects/p1/agent-sessions/s1/restart'],
      ]) {
        expect(connectionTokenRequiredScope(method, path), `${method} ${path}`).toBeNull();
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

  it('鉴权入口按方法 + 路径 + 查询串查这张表，并用表里返回的 scope 校验', () => {
    // 查询串必须一起传：有的路由只有带上收敛参数才在放行范围内，少传这个实参
    // 不会报错，只会让那条路由静默失效（形状 2：链路只建一半）。
    const call = serverSource.match(/connectionTokenRequiredScope\(\s*req\.method,\s*req\.path([^)]*)\)/);
    expect(call, '鉴权入口没有按 (method, path, …) 查这张表').not.toBeNull();
    expect(call![1], '鉴权入口没有把 req.query 传进去').toContain('req.query');
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
  const ROUTES_TO_CHECK: ReadonlyArray<[string, string, Record<string, unknown>?]> = [
    ['GET', '/api/reports'],
    ['GET', '/api/reports/rep-1/raw'],
    ['POST', '/api/bridge/command/b1'],
    ['GET', '/api/projects/p1/agent-runtime-providers'],
    ['POST', '/api/projects/p1/agent-sessions'],
    ['POST', '/api/projects/p1/agent-sessions/s1/messages'],
    ['GET', '/api/projects/p1/agent-sessions/s1/stream'],
    ['POST', '/api/projects/p1/agent-sessions/s1/tool-approvals/a1'],
    ['POST', '/api/projects/p1/agent-sessions/s1/stop'],
    ['GET', '/api/projects/p1/agent-sessions/s1/logs'],
    ['GET', '/api/projects/p1/agent-sessions', { clientRequestId: 'req-1' }],
    ['GET', '/api/projects/p1/agent-sessions/s1'],
  ];

  it('表里要求的每个范围，默认授权都发得出来', () => {
    for (const [method, path, query] of ROUTES_TO_CHECK) {
      const scope = connectionTokenRequiredScope(method, path, query);
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

/**
 * MAP 拿这把连接凭据去打的每一条 CDS 路径，**连同方法**，都得在这张表里表过态。
 *
 * 同一个洞连开两次：会话回读、会话回查两条 GET 都曾躺在拒绝名单里，理由都写着
 * 「未被 MAP 使用的旁路」——而 MAP 用的正是它们，于是停止清理被判成永久失败、
 * OpenDesign 经配对连接根本起不来（形状 2：链路只建一半，且两边都不会红——
 * CDS 侧的用例证明「门关得严」，MAP 侧的用例用的是桩）。
 *
 * 判据必须到方法这一级：第二次那条路径上 POST 早就开着，只按路径判的话
 * 「GET 没开」根本看不出来（形状 1：判据比它该管的范围窄）。
 */
describe('MAP 用到的每条 CDS 调用（方法 + 路径）都表过态', () => {
  type Verdict = 'allowed' | 'denied';
  const EXPECTED: Readonly<Record<string, { verdict: Verdict; why: string }>> = {
    'GET /api/projects/p1/agent-runtime-providers': { verdict: 'allowed', why: '运行时目录' },
    'POST /api/projects/p1/agent-sessions': { verdict: 'allowed', why: '创建会话' },
    'GET /api/projects/p1/agent-sessions?clientRequestId': {
      verdict: 'allowed',
      why: '按 clientRequestId 回查 202 预约最终建成了哪一份运行时（不带参数的整份清单不在此列）',
    },
    'GET /api/projects/p1/agent-sessions/s1': { verdict: 'allowed', why: '停止返回不可判定错误时回读这一条' },
    'POST /api/projects/p1/agent-sessions/s1/stop': { verdict: 'allowed', why: '停止' },
    'POST /api/projects/p1/agent-sessions/s1/messages': { verdict: 'allowed', why: '提交本轮任务' },
    'GET /api/projects/p1/agent-sessions/s1/stream?afterSeq&follow': { verdict: 'allowed', why: '续接事件流' },
    'GET /api/projects/p1/agent-sessions/s1/logs': { verdict: 'allowed', why: '脱敏运行诊断' },
    'POST /api/projects/p1/agent-sessions/s1/tool-approvals/a1': { verdict: 'allowed', why: '工具审批回送' },
    'POST /api/projects/p1/files': {
      verdict: 'denied',
      why: '有意不开：一把连接凭据不该能往已授权项目里写任意文件。MAP 那个注入端点因此走不通，这是取舍不是缺陷',
    },
  };

  const readMapCalls = (): string[] => {
    const file = join(
      process.cwd(),
      '../prd-api/src/PrdAgent.Infrastructure/Services/InfraAgentSessions/InfraAgentSessionService.cs',
    );
    // 读不到就当场红，不跳过：一条不会红的守卫比没有守卫更糟。
    const lines = readFileSync(file, 'utf8').split('\n');
    const methodAt = new Map<number, string>();
    lines.forEach((line, index) => {
      const match = line.match(/HttpMethod\.(Get|Post|Put|Patch|Delete)\b/);
      if (match) methodAt.set(index, match[1].toUpperCase());
    });

    const calls = new Set<string>();
    lines.forEach((line, index) => {
      const literal = line.match(/"(\/api\/projects\/[^"]*)"/);
      if (!literal) return;
      let path = literal[1].split('?')[0];
      // 查询参数名也要扫出来：有的路由**只有带上收敛参数**才在放行范围内，
      // 只比对路径的话，MAP 哪天把参数丢了、或白名单哪天不再要求它，两头都不会红。
      // 字面量常被拆成两行（`".../agent-sessions"` + `"?clientRequestId={...}"`），
      // 所以连着往后看两行。
      const queryText = [literal[1], lines[index + 1] || '', lines[index + 2] || '']
        .map((text) => {
          const inline = text.match(/\?([A-Za-z0-9_{}().$&=\-]*)/);
          return inline ? inline[1] : '';
        })
        .filter(Boolean)
        .join('&');
      const queryNames = [...new Set(
        queryText
          .split('&')
          .map((pair) => pair.split('=')[0].trim())
          .filter((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name)),
      )].sort();
      let segment = 0;
      // 形如 {Uri.EscapeDataString(x)} 的插值，按它在路径里的位置换成占位段。
      path = path.replace(/\{[^{}]*\}/g, () => {
        segment += 1;
        return segment === 1 ? 'p1' : segment === 2 ? 's1' : 'a1';
      });
      // 方法就写在同一次调用的相邻几行；找不到或找到多个就判红，不允许猜。
      const near = [...methodAt.entries()]
        .filter(([at]) => Math.abs(at - index) <= 6)
        .sort((a, b) => Math.abs(a[0] - index) - Math.abs(b[0] - index));
      expect(near.length, `${path}（源码第 ${index + 1} 行）附近找不到 HttpMethod，扫描规则需要更新`)
        .toBeGreaterThan(0);
      calls.add(`${near[0][1]} ${path}${queryNames.length ? `?${queryNames.join('&')}` : ''}`);
    });
    return [...calls].sort();
  };

  it('扫得到 MAP 的调用（正则失效就当场红，而不是扫出空集合判绿）', () => {
    const calls = readMapCalls();
    expect(calls.length).toBeGreaterThan(5);
    // 带参数那条必须原样扫出来：MAP 哪天不再送 clientRequestId，这里当场红，
    // 而不是等到白名单默默把整份会话清单开出去。
    expect(calls).toContain('GET /api/projects/p1/agent-sessions?clientRequestId');
    expect(calls).toContain('POST /api/projects/p1/agent-sessions');
  });

  it('每条都在表里有结论，且结论与白名单一致', () => {
    for (const call of readMapCalls()) {
      const [method, target] = call.split(' ');
      const [path, queryText] = target.split('?');
      const query = Object.fromEntries(
        (queryText ? queryText.split('&') : []).map((name) => [name, `v-${name}`]),
      );
      const expected = EXPECTED[call];
      expect(
        expected,
        `MAP 会用连接凭据打 ${call}，但这张表没有它的结论——请显式决定开还是不开`,
      ).toBeDefined();
      const scope = connectionTokenRequiredScope(method, path, query);
      if (expected!.verdict === 'allowed') {
        expect(scope, `${call}（${expected!.why}）应当放行，白名单却把它挡了`).not.toBeNull();
      } else {
        expect(scope, `${call}（${expected!.why}）不该放行`).toBeNull();
      }
    }
  });
});
