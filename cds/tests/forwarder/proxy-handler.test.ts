/**
 * Forwarder HTTP 代理处理 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 3.3 / 4.4 / 5.1
 * 实现位置(尚未存在):cds/src/forwarder/proxy-handler.ts
 *
 * 代理处理器职责:RouteResolver 给出 upstream 后,完成 HTTP/1.1 + WebSocket
 * + SSE 透传;upstream 不可达时返回 cds-waiting 页面;统计请求指标。
 */
import { describe, it } from 'vitest';

describe('ProxyHandler — HTTP 透传', () => {
  it.todo('[C-3.3] 简单 GET 请求 P50 转发延迟 < 5ms,P99 < 30ms(本机)');
  it.todo('[C-3.3] 大 body POST(5MB)能正确流式转发');
  it.todo('[C-3.3] response headers 完整透传(包括自定义 X-* header)');
  it.todo('[C-3.3] X-Forwarded-For 正确累积(append,不覆盖)');
  it.todo('[C-3.3] X-Forwarded-Proto 根据 nginx 上游传入的值');
  it.todo('[C-3.3] Host header 透传给 upstream(让上游识别原始域名)');
});

describe('ProxyHandler — SSE / WebSocket / 长连接', () => {
  it.todo('[C-3.3] SSE 长连接持续 5 秒,期间收到 ≥ 5 条 event 全部透传');
  it.todo('[C-3.3] SSE 客户端主动断开 → 后端连接也释放(无泄漏)');
  it.todo('[C-3.3] WebSocket Upgrade 握手成功');
  it.todo('[C-3.3] WebSocket 双向消息透传');
});

describe('ProxyHandler — 故障与降级', () => {
  it.todo('[C-1.2] 路由查不到 → 503 + cds-waiting 页面');
  it.todo('[C-5.1] upstream connect 拒绝(端口未开)→ 503 + waiting 页面 + 标记 healthState=unhealthy');
  it.todo('[C-5.1] upstream 5s 无响应 → 504 + waiting 页面');
  it.todo('[C-5.1] upstream 中途 reset → 给客户端 502 + waiting 页面');
  it.todo('[C-4.4] upstream URL 来自路由表,不接受 client header 改写(防止 SSRF)');
});

describe('ProxyHandler — 资源回收', () => {
  it.todo('[C-3.3] 1000 次请求后,文件描述符数量稳定(无 leak)');
  it.todo('[C-3.3] keepalive 复用上游连接(不每次都新建 socket)');
});
