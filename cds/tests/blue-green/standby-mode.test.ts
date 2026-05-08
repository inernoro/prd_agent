/**
 * Admin Daemon Standby 模式 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 1.5 / 4.1 / 4.6
 * 实现位置:cds/src/index.ts(改造)+ cds/src/middleware/standby-guard.ts(新增)
 *
 * Standby 模式是新 daemon 启动后的初始状态:监听端口,响应 healthz,
 * 但 worker / scheduler / 业务写接口全部禁用,直到 supervisor 调
 * /api/_internal/promote 才"激活"。
 */
import { describe, it } from 'vitest';

describe('Standby 启动行为', () => {
  it.todo('[C-1.5] daemon 启动时若 .cds/active-color 已存在且自身颜色 != active → 进 standby');
  it.todo('[C-1.5] 命令行 --standby 强制 standby');
  it.todo('[C-1.5] standby 模式下 /healthz 返回 200 + status=standby');
  it.todo('[C-1.5] standby 模式下 /api/self-status 返回 active=false');
  it.todo('[C-1.5] standby 启动时**不**调用 schedulerService.start() / janitorService.start()');
  it.todo('[C-1.5] standby 启动时**不**注册 SSE event bus 写入(只读)');
});

describe('Standby 写入隔离', () => {
  it.todo('[C-4.6] standby 实例收到 POST /api/branches → 返回 503 + JSON { error: "standby" }');
  it.todo('[C-4.6] standby 实例收到 PUT /api/projects/:id → 拒绝');
  it.todo('[C-4.6] standby 实例收到 DELETE /api/* → 拒绝');
  it.todo('[C-4.6] standby 仍允许只读 GET(self-status / projects / branches)');
  it.todo('[C-4.6] standby 收到 webhook(/api/github/webhook)→ 拒绝并提示用 active');
  it.todo('[C-4.6] standby 收到 Bridge command 调用 → 拒绝');
});

describe('/api/_internal/promote 激活', () => {
  it.todo('[C-1.5] 来自回环 127.0.0.1 的 POST /api/_internal/promote → 200 + 解禁写入');
  it.todo('[C-4.1] 来自非回环 IP 的请求 → 403');
  it.todo('[C-4.1] X-Forwarded-For 伪造仍 403');
  it.todo('[C-1.5] promote 后启动 schedulerService + janitorService');
  it.todo('[C-1.5] promote 后写 .cds/active-color 为自身颜色');
  it.todo('[C-1.5] 重复调用 promote → 200 但幂等(不重复启动 scheduler)');
});

describe('/api/_internal/standby 反向降级(运维手动触发)', () => {
  it.todo('[C-1.5] 来自回环的 POST /api/_internal/standby → 进入 standby + 停 scheduler');
  it.todo('[C-4.1] 来自非回环 → 403');
});
