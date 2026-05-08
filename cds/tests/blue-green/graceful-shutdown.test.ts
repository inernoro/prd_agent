/**
 * Graceful Shutdown — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 3.4 / 5.3
 * 实现位置(尚未存在):cds/src/services/graceful-shutdown.ts
 *
 * 旧 daemon 收到 SIGTERM 后,停止接收新请求,drain 现有 SSE / 业务任务,
 * 30s 兜底超时强杀。
 */
import { describe, it } from 'vitest';

describe('Graceful Shutdown — 信号处理', () => {
  it.todo('[C-5.3] 收到 SIGTERM → 切到 draining 模式');
  it.todo('[C-5.3] draining 模式下 /healthz 返回 503(让上游不再分流量)');
  it.todo('[C-5.3] draining 模式下新连接立即关闭(server.close 不再 accept)');
  it.todo('[C-5.3] 已建立的连接继续处理,直到客户端关或自然结束');
});

describe('Graceful Shutdown — SSE 长连接', () => {
  it.todo('[C-5.3] draining 时给所有现存 SSE 连接发一条 close event(让客户端主动断开重连到新 daemon)');
  it.todo('[C-5.3] 客户端断开后 SSE 连接立即释放');
});

describe('Graceful Shutdown — Worker / Run 任务', () => {
  it.todo('[C-5.3] draining 时新 run 不再启动');
  it.todo('[C-5.3] 进行中的 run 等待完成(最长 25 秒)');
  it.todo('[C-5.3] 25 秒内未完成的 run 标 status="interrupted",写 mongo,新 daemon 启动 reconcile 接管');
});

describe('Graceful Shutdown — Mongo flush', () => {
  it.todo('[C-5.3] draining 阶段把 write-behind buffer 全部 flush 到 mongo');
  it.todo('[C-5.3] flush 失败的关键 state(active update / 流水)落盘 .cds/pending-writes.json');
});

describe('Graceful Shutdown — 兜底超时', () => {
  it.todo('[C-3.4] 30 秒兜底:无论是否 drain 完成,SIGKILL 自杀');
  it.todo('[C-3.4] 兜底前打印当前残留 SSE / Run 数,便于 post-mortem');
  it.todo('[C-5.3] 兜底强杀写流水 forced-shutdown=true');
});
