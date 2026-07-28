# CDS 存活监控（uptime-monitor） · 债务台账

> **版本**：v1.0 | **日期**：2026-07-27 | **状态**：开发中

## 总览

CDS 自建存活监控（`cds/src/services/uptime-monitor.ts` + `uptime-metrics.ts` + `routes/uptime.ts` +
状态页 `cds/web/src/pages/StatusPage.tsx`）按固定间隔直连容器宿主端口探测每个分支服务，
产出可用率柱条、故障事件时间线与状态页。

本台账记录首版复审暴露、且**有意延期**的边界项，防止下一次 session 无人记得。
第一条是本次已缓解但未根治的核心债务：**探测口径假定所有对外服务都说 HTTP**。

模块范围：`cds/src/services/uptime-monitor.ts`、`cds/src/services/uptime-metrics.ts`、
`cds/src/routes/uptime.ts`、`cds/web/src/pages/StatusPage.tsx`、`cds/web/src/lib/statusView.ts`。

## 债务 1（核心）：非 HTTP 服务会被误判为故障

### 现象

`selectProbeTargets` 对每个 running 分支的每个 build profile，只要拿到 `hostPort` 就产出
`http` 类型的探测目标；默认探测 `GET http://127.0.0.1:<hostPort>/`，以「状态码 < 500 即存活」判定。
于是下列服务会连续判失败：

- gRPC / h2c 服务（对 HTTP/1.1 GET 返回连接重置或非 HTTP 响应）；
- 纯 worker（端口只为占位或做内部通信，根本不监听 HTTP）；
- profile 发布出来的裸 TCP 端口（数据库代理、消息通道等）；
- 根路径本身就返回 5xx 的服务（未配置根路由、根路径故意 500）。

后果不是「多一条红」而是**状态页整体失真**：故障计数常年非 0，横幅永远显示「N 个服务异常」，
每个误判目标还会合成一条永不结束的 incident，真故障被噪声淹没——比没有状态页更糟。

### 当前缓解手段（2026-07-27 落地）

| 手段 | 做法 | 覆盖 |
|------|------|------|
| 逃生阀 | 环境变量 `CDS_UPTIME_EXCLUDE` 排除名单，逗号/分号/空白分隔，单条支持 `*` 通配，按「目标 id / profile id / 分支 id / 项目 或 服务 / 展示名」任一维度匹配。命中者不探测、不计故障，状态页标「未纳入监控」并列出命中的规则 | 全部四类，但需要运维显式配置 |
| 自动降级 | 目标**从未**成功答过 HTTP、且连续 `failureThreshold` 次拿到**协议层**错误（连接被重置 / 响应解析失败 / 非 HTTP 响应 / socket hang up）时，自动改按容器状态判定，状态页标「已自动降级 · 按容器状态判定」并写明原因。连接被拒、超时、5xx 一律**不**降级（那是真故障） | gRPC / 裸 TCP（端口开着但不说 HTTP）自动生效，零配置 |

回归见 `cds/tests/services/uptime-monitor-cycle.test.ts` 的「排除名单（逃生阀）」与
「非 HTTP 响应自动降级为容器状态判定」两组用例。

### 仍然欠着的（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | 纯 worker / 端口无人监听仍会误报 | 这类目标探测拿到的是 `ECONNREFUSED`（不可达），与「HTTP 服务真挂了」不可区分，故意不自动降级。只能靠 `CDS_UPTIME_EXCLUDE` 手动排除 | 未配置排除名单时仍会红 |
| 2 | 根路径返回 5xx 的服务仍会误报 | 拿到 HTTP 状态码说明对面在说 HTTP，按现有口径就是故障。根本解法是让 profile 声明健康检查路径（复用 `readinessProbe`），本次未做——`ProbeTarget` 只从 `BranchEntry.services` 推导，拿不到 profile 定义 | 需手动排除 |
| 3 | 排除名单只有环境变量入口 | 没有项目级 / profile 级字段，也没有 UI 开关，改名单要改环境变量并重启 CDS。后续可加 `BuildProfile.uptime.enabled` 与「CDS 系统设置」里的开关 | 运维便利性 |
| 4 | 降级是粘性的 | 一旦降级，只有该服务的宿主机端口发生变化（重新部署重分配端口）才会解除并重新试 HTTP。同端口重启的服务从「不说 HTTP」变成「说 HTTP」时，需删除 `.cds/uptime-monitor.json` 才能回到 HTTP 探测 | 概率低，可手动清台账 |
| 5 | 降级前的失败采样仍计入可用率 | 触发降级前的 `failureThreshold - 1` 次协议层失败已经落进采样与日聚合，会把该目标 24h 可用率压低一截（不开 incident、不判 down） | 首次接入后 24 小时内的可用率数字偏低 |
| 6 | 探测路径固定为 `/`，方法固定 GET | 不支持自定义路径 / 方法 / 期望状态码，鉴权网关型服务只能靠「< 500 即存活」兜底 | 判定精度 |

## 债务 2：状态页与探测器的次要边界（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | 无告警外发 | 判 down 只体现在状态页与故障时间线，没有站内通知 / Webhook / 邮件。用户不主动打开 `/status` 就不知道 | 需人工巡视 |
| 2 | 探测台账不跨实例共享 | 落盘在单机 `.cds/uptime-monitor.json`，多实例部署各存各的，可用率不合并 | 集群场景数据分散 |
| 3 | 状态页无单目标下钻 | `GET /api/uptime/targets/:id/history` 已就绪并做了降采样，前端尚未提供点开柱条看时序的入口 | 排障需直接调 API |

## 相关

- 规则：`.claude/rules/concurrency-gate-discipline.md`（周期收敛 / 健康不变量）、
  `.claude/rules/expectation-management.md`（状态页的三态与等待反馈）。
- 回归：`cds/tests/services/uptime-monitor-cycle.test.ts`、`cds/tests/services/uptime-metrics.test.ts`、
  `cds/tests/web/status-page-view-state.test.ts`。
