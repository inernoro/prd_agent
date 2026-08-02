import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 接线守卫：通知账本整条链路由若干「一行接线」串起来，**每一行删掉都不会红，
 * 只会静默退化**——账本类还在、单测照常全绿，只是永远没有东西写进去 / 永远不外发 /
 * 永远不实时亮铃。而告警缺失恰恰是最难被发现的缺陷（没人会注意到没响过的铃）。
 *
 * 四条钉住的接线：
 *   1. server.ts 真的调了 startNoticeLedger，且把 ledger + outbound 都传了进去；
 *   2. server.ts 真的挂了 createNoticesRouter（否则前端 GET /api/notices 404）；
 *   3. index.ts 把存活监控的 onAlert 接上了总线（否则「健康掉线」这一路事件源不存在）；
 *   4. web 的 useCdsEvents 两处都注册了 notice.created（只改联合类型不改 types 数组
 *      不会报错，只会让通知最多隐身 25s 心跳——operator.request.* 栽过同款）。
 *
 * 另外本地再钉一次「账本不许出现发布事件字面量」：真正的判红在
 * release-event-source-guard.test.ts，这里提前一步给出更直白的失败信息。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relativePath), 'utf8');
}

/**
 * 窗口化：拿全文 contains 断言「有人调用它」是假绿——把调用摘掉、类型定义或 import
 * 留着，守卫照样通过。release-observability-wiring-guard 实测过这个假绿，照抄其写法。
 */
function windowAfter(source: string, anchor: string, size: number): string {
  const at = source.indexOf(anchor);
  expect(at, `未找到接线锚点：${anchor}`).toBeGreaterThan(-1);
  return source.slice(at, at + size);
}

describe('通知账本接线守卫', () => {
  it('server.ts 启动了账本订阅，并把外发配置一起传了进去', () => {
    const source = read('src/server.ts');
    expect(
      source,
      '外发配置必须由 resolveNoticeOutboundConfig 从 env 解析（凭据只在服务端）',
    ).toContain('resolveNoticeOutboundConfig(');

    const call = windowAfter(source, 'startNoticeLedger(', 900);
    expect(call, 'startNoticeLedger 必须拿到账本实例').toContain('ledger:');
    expect(
      call,
      '外发接线被摘掉后账本照常记账、只是永远不外发——删掉不会红，故在此钉住',
    ).toContain('outbound: noticeOutbound');
  });

  it('server.ts 挂载了站内信路由（否则前端拉账本 404）', () => {
    const source = read('src/server.ts');
    const mount = windowAfter(source, 'createNoticesRouter(', 400);
    expect(mount).toContain('ledger:');
    expect(mount, '外发未配置时必须能如实告诉前端').toContain('getOutboundStatus');
  });

  it('server.ts 为每条站内信路由都登记了中文 label（Activity Monitor 可读）', () => {
    const source = read('src/server.ts');
    for (const key of ['GET /notices', 'POST /notices', 'POST /notices/read-all', 'POST /notices/:id/handling']) {
      expect(source, `resolveApiLabel 缺少 ${key} 的中文 label`).toContain(`'${key}':`);
    }
    for (const pattern of ['\\/notices\\/[^/]+\\/dismiss', '\\/notices\\/[^/]+\\/handling']) {
      expect(
        source,
        `带具体 id 的真实调用只能靠 patterns 正则拿到 label，缺少 ${pattern}`,
      ).toContain(pattern);
    }
  });

  /**
   * 处理状态机（认领闭环）的三段接线。每一段删掉都**不会红**：
   *   - 路由不调 setHandling → 端点照常 200，状态永远不变（服务类和它的单测全绿）；
   *   - 前端不调该端点 → 按钮点了没反应，刷新就回到「没人处理」；
   *   - 前端不读 handling → 服务端状态存对了，界面永远显示「待处理」。
   * 三段都是「静默退化」，故在此逐条钉住。
   */
  it('routes/notices.ts 的 handling 端点真的把状态写进账本', () => {
    const source = read('src/routes/notices.ts');
    const route = windowAfter(source, "router.post('/notices/:id/handling'", 1200);
    expect(
      route,
      '端点没调 ledger.setHandling：请求照常 200，状态却永远不变（删掉不会红，故守卫）',
    ).toContain('deps.ledger.setHandling(');
    expect(
      route,
      '没带作用域调用：项目级 Key 会推动别的项目的通知',
    ).toContain('projectScopeOf(req)');
    expect(
      route,
      '没取变更者：状态改了却查不出谁在什么时候改的',
    ).toContain('noticeActorOf(req)');
  });

  it('身份取值只有一处口径，且不拿调用通道兜底（无身份就是 null）', () => {
    const source = read('src/routes/notices.ts');
    const actor = windowAfter(source, 'export function noticeActorOf(', 1200);
    expect(actor, '身份必须从 req.cdsUser 取（只有 github / SSO 会话才有）').toContain('cdsUser');
    expect(
      actor,
      '共享凭据造出来的伪 id 必须被拒（否则默认 basic 部署里每条通知都被"同一个人"认领）',
    ).toContain('isRealIdentity(');
    // resolveActorFromRequest 只能落在 channel 字段上。它把所有 cookie 登录的真人
    // 合并成字面量 'user'，一旦被当成 userId/userLabel 就是一个假责任人。
    expect(actor).toMatch(/channel\s*[:=]\s*resolveActorFromRequest\(req\)|const channel = resolveActorFromRequest\(req\)/);
    expect(actor).not.toMatch(/userId:\s*channel|userLabel:\s*channel/);
  });

  it('SiteNoticeInbox 真的调了 handling 端点，并按状态渲染', () => {
    const source = read('web/src/components/SiteNoticeInbox.tsx');
    expect(
      source,
      '前端不调该端点 = 按钮点了没反应，刷新就回到「没人处理」',
    ).toContain('/handling`');
    expect(
      source,
      '前端不读状态 = 服务端存对了、界面永远显示「待处理」',
    ).toContain('noticeStatusOf(notice)');
    expect(
      source,
      '筛选必须走服务端 ?status=（前端再筛一遍就是第二份口径，迟早与后端漂）',
    ).toContain('?status=');
    expect(
      source,
      '认领人为空时必须走 noticeHandlerText 的如实文案，不许自己拼一个名字',
    ).toContain('noticeHandlerText(');
  });

  it('前后端对「旧记录算什么状态」是同一个口径（都归 open）', () => {
    // 两份实现无法共享（Node 侧 / 浏览器侧各自打包），只能钉住口径一致：
    // 任一侧把缺席的 handling 判成别的档，存量告警就会在那一侧整批消失。
    const backend = read('src/services/notice-ledger.ts');
    const frontend = read('web/src/lib/noticeStatus.ts');
    for (const [file, source] of [['后端', backend], ['前端', frontend]] as const) {
      const statuses = windowAfter(source, 'NOTICE_STATUSES', 200);
      expect(statuses, `${file} 的状态枚举必须是 open/working/resolved 三档`).toContain("'open'");
      expect(statuses).toContain("'working'");
      expect(statuses).toContain("'resolved'");
      expect(
        source,
        `${file} 缺少 noticeStatusOf：状态取值一旦分裂成多处各自兜底，两处迟早漂`,
      ).toContain('noticeStatusOf');
    }
  });

  it('index.ts 把存活监控的翻转事件接上了总线（健康掉线这一路事件源）', () => {
    const source = read('src/index.ts');
    const construct = windowAfter(source, 'new UptimeMonitorService(', 1400);
    expect(
      construct,
      'onAlert 没接 = 生产掉线只躺在 incidents 台账里，账本收不到、没人被通知',
    ).toContain('onAlert:');
    expect(construct).toContain('cdsEventsBus.publish');
  });

  it('useCdsEvents 三处都认 notice.created（漏 addEventListener 会静默不实时）', () => {
    const source = read('web/src/hooks/useCdsEvents.ts');

    // 只数出现次数是假绿：routeEvent 的 case 分支也带这个字面量，
    // 把 types 数组那一行删掉后总数仍 >= 2。必须窗口化到真正的注册数组——
    // EventSource 只派发已 addEventListener 的类型，漏注册的最多靠 25s 心跳隐身通过。
    const typesArray = windowAfter(source, 'const types: CdsEventType[] = [', 1600);
    expect(
      typesArray,
      'openConnection 的 types 数组漏了 notice.created：'
        + 'EventSource 不会派发未注册的事件类型，铃铛永远不会实时亮（operator.request.* 栽过同款）',
    ).toContain("'notice.created'");

    const unionType = windowAfter(source, 'export type CdsEventType =', 1600);
    expect(unionType, 'CdsEventType 联合类型缺 notice.created').toContain("'notice.created'");

    expect(source, 'routeEvent 未处理 notice.created，事件到了也不会进 store').toContain("case 'notice.created':");
  });

  it('账本与外发适配器不含任何发布生命周期事件字面量', () => {
    for (const file of ['src/services/notice-ledger.ts', 'src/services/notice-outbound-map.ts']) {
      const text = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      for (const literal of ['release.started', 'release.succeeded', 'release.failed', 'release.rolled-back']) {
        expect(
          text.includes(literal),
          `${file} 出现 ${literal}：事件 → 文案/入账的映射只许留在 cds-events-bus.ts`,
        ).toBe(false);
      }
    }
  });
});
