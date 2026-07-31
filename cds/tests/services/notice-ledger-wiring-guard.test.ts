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

  it('server.ts 为四条站内信路由都登记了中文 label（Activity Monitor 可读）', () => {
    const source = read('src/server.ts');
    for (const key of ['GET /notices', 'POST /notices', 'POST /notices/read-all']) {
      expect(source, `resolveApiLabel 缺少 ${key} 的中文 label`).toContain(`'${key}':`);
    }
    expect(
      source,
      'POST /notices/:id/dismiss 的真实调用带具体 id，必须靠 patterns 正则才有 label',
    ).toContain('\\/notices\\/[^/]+\\/dismiss');
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
