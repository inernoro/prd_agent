/**
 * Forwarder 路由表监听 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 1.3 / 1.4 / 3.6 / 8.4
 * 实现位置(尚未存在):cds/src/forwarder/route-watcher.ts
 *
 * 路由表监听器职责:订阅 mongo change stream,实时把变更原子替换到内存表;
 * mongo 不可达时降级到本地 JSON 快照。
 */
import { describe, it } from 'vitest';

describe('RouteWatcher — mongo change stream 实时更新', () => {
  it.todo('[C-1.3] 启动时一次性 fullScan,把现有路由全部加载进内存');
  it.todo('[C-1.3] mongo insert 一条新路由,内存表 P95 < 500ms 内出现新条目');
  it.todo('[C-1.3] mongo update 路由(改 weight),内存表对应记录字段同步');
  it.todo('[C-1.3] mongo delete 路由,内存表对应记录消失');
  it.todo('[C-3.6] 100 条变更连续推送,内存表与 mongo 最终一致(eventual consistency)');
  it.todo('[C-3.6] change stream 推送延迟 P99 < 500ms');
  it.todo('[C-1.3] 内存表替换是原子的(同一时刻读到的总是完整一致快照,不会读到一半)');
});

describe('RouteWatcher — 本地 JSON fallback', () => {
  it.todo('[C-1.4] mongo 启动时连不上 → 加载 .cds/forwarder-routes.json + 标 healthState=fallback');
  it.todo('[C-1.4] mongo 运行中断线 → 内存表保留最后状态,标 healthState=stale,不清空');
  it.todo('[C-1.4] mongo 恢复后自动重连 + 重新 fullScan + 切回 healthState=live');
  it.todo('[C-8.4] mongo collection 损坏(不可读) → fallback 到 JSON 启动,告警事件入流水');
  it.todo('[C-1.4] 每次 mongo 全量同步成功后,把当前内存表落盘 .cds/forwarder-routes.json(下次启动有兜底)');
});

describe('RouteWatcher — 心跳与重连', () => {
  it.todo('[C-1.4] watcher 自身 5s 心跳,失败 3 次切到 fallback');
  it.todo('[C-1.4] fallback 模式下每 30s 尝试重连一次,成功立即切回 live');
});
