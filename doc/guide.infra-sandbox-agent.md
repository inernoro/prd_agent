# guide.infra-sandbox-agent

> **基础设施建设 — 沙箱 Agent**
>
> 完整端到端手册：设计思路、历程、UI 位置、操作步骤、测试方法、已知边界。
> 这是面向"想要在 MAP 平台上把 sidecar / 共享基础设施服务托管起来"的运营 / 开发的 SSOT。

| 字段 | 内容 |
|---|---|
| 版本 | v1（剪贴板配对协议落地版） |
| 状态 | 实现完成，待正式环境真人验收 |
| 责任人 | Claude Code |
| 时间 | 2026-05-07 |
| 关联 | `doc/spec.cds.map-pairing-protocol.md`、`doc/design.cds.agent.sdk-executor.md`、`doc/debt.cds.agent.sdk-executor.md`、`doc/guide.cds.agent.sdk-quickstart.md` |

---

## 0. 管理摘要

把 Anthropic Agent SDK / 任意"长生命周期共享基础设施服务"接进系统，过去要让运营懂 docker / SSH / 配置文件；本版本之后只剩**两个动作**：在 CDS 端点一下「创建连接密钥」复制，在 MAP 端粘贴 → 完成。CDS 自动建项目、加密存储凭据、暴露实例发现 API；MAP 端自动落库、加密、列表。未来任何继承 Executor 接口的部署平台（k8s / Nomad / 用户自托管 CLI）都通过同一协议接入，无需改主系统代码。

---

## 1. 设计思路

### 1.1 三层职责划分

```
┌────────────────────────────────────────────────────────┐
│  MAP（prd-admin + prd-api）                             │
│  - 业务消费方                                           │
│  - 路由 / 调度 / 复制集 / 业务监听                       │
│  - 不写任何"操作远程主机/容器"代码                        │
└────────────────────────────────────────────────────────┘
                       ↑ 配对密钥 + 长效 token + 实例发现
                       ↓
┌────────────────────────────────────────────────────────┐
│  CDS（独立部署平台）                                     │
│  - 远程主机登记 + SSH 部署引擎                          │
│  - 容器健康检查 + 日志                                  │
│  - shared-service Project 自动创建                      │
│  - 实例发现 API 暴露给 MAP                              │
└────────────────────────────────────────────────────────┘
                       ↑ docker pull / run
                       ↓
┌────────────────────────────────────────────────────────┐
│  Sidecar 进程（claude-sdk-sidecar 等）                   │
│  - HTTP + SSE 协议                                      │
│  - 持有上游凭据（Anthropic / DeepSeek / Kimi / GLM）    │
│  - 多轮 tool_use 循环                                   │
└────────────────────────────────────────────────────────┘
```

**核心隐喻**：MAP = 总指挥（业务），CDS = 工兵（部署），Sidecar = 前线步兵（实际跑业务）。三层各司其职，谁也不越界。

### 1.2 为何选剪贴板配对而非"录入字段"

旧设想（已废弃）：让运营在 MAP 端填 CDS BaseUrl + token + 心跳间隔等十几个字段。失败：运营不懂、字段语义易错、token 在 UI 里裸传输。

新设计：CDS 端一键生成密钥（base64url JSON 含全部上下文），用户**只复制粘贴**，所有字段由协议自动协商。

详细 contract 见 `doc/spec.cds.map-pairing-protocol.md`。

### 1.3 为何 CDS 创建 shared-service Project 而不是 RemoteHost

`RemoteHost` 是 v0 模型，"每主机部署一个 sidecar"。后续要支持"一个服务部署到多主机"必须升级。`shared-service` Project 抽象出"服务"概念，绑定 `targetHostIds[]`，未来支持多副本 / 蓝绿 / 滚动升级零结构改动。

### 1.4 为何用 SHA256 hash 而非加密存 token

token 验证只需要"知不知道"，不需要"复原"。hash 比对足以；明文不出库等价于不可被解密泄漏。`pairingToken` TTL 10 分钟一次性，`cdsLongToken` 默认 1 年但可 revoke + rotate。

---

## 2. 历程（决策链路）

| 时间 | 决策点 | 选择 | 原因 |
|---|---|---|---|
| 2026-05-04 | 接 Claude Agent SDK | Python sidecar 进程 + HTTP/SSE | 不让 .NET 进程持 anthropic 凭据；让 sidecar 跨上游切换 |
| 2026-05-05 | sidecar 部署归属 | CDS 不重写 | CDS 已有 80% 容器编排能力 |
| 2026-05-06 | sidecar 模型 | RemoteHost = 部署单位 | MVP，简化 |
| 2026-05-06 | 升级到 shared-service Project | Project.kind 加新值 | 多主机一个服务 + 未来扩展 |
| 2026-05-07 | MAP↔CDS 配对方式 | **剪贴板密钥** | 体验零摩擦，凭据自动协商 |
| 2026-05-07 | 协议版本 | v1，prefix `cds-connect:v1:` | 未来 v2 兼容 |

---

## 3. 架构总览

```
[运营 / 开发]
   │
   │ ① 在 CDS UI 点「创建连接密钥」复制
   │ ② 在 MAP UI 粘贴
   │
[MAP 平台]                                      [CDS 平台]
prd-admin /infra-services                        cds-settings#connections
   │                                                │
   ├── POST /api/infra-connections/paste            ├── POST /api/cds-system/connections/issue
   │   解析密钥 → 调对端 CDS                         │   生成 pairingToken + 剪贴板文本
   │   accept                                        │
   │                                                ├── POST /api/cds-system/connections/accept
   │                                                │   验证 pairingToken hash + TTL
   │                                                │   自动创建 shared-service Project
   │                                                │   签发 cdsLongToken
   ↓                                                ↓
prd-api                                          CDS state
   InfraConnection                                  CdsConnection (active)
   IDataProtector 加密 longToken                    longTokenHash + projectId
   │                                                │
   │ DynamicSidecarRegistry                          │ /api/projects/<id>/instances
   │ 30s 拉一次 ──────────────────────────────────► │
   │                                                │
   ├── ClaudeSidecarRouter                           ├── /api/cds-system/remote-hosts/*
   │   按 tag/sticky/加权选实例                       │   登记主机 + 一键部署 Sidecar
   │                                                │
   ↓                                                ↓
[Sidecar 进程]
   POST /v1/agent/run (SSE)
   ↓
[Anthropic / DeepSeek / Kimi / GLM 上游]
```

---

## 4. 组件位置（每件东西在哪）

### 4.1 后端代码

| 模块 | 文件 |
|---|---|
| 协议规范 | `doc/spec.cds.map-pairing-protocol.md` |
| **CDS 端配对** | `cds/src/services/connection/pairing-service.ts` |
| CDS 端路由 | `cds/src/routes/cds-system-connections.ts` |
| CDS 端类型 | `cds/src/types.ts` (CdsConnection / RemoteHost / ServiceDeployment / Project.kind='shared-service') |
| CDS 端状态 | `cds/src/services/state.ts` (CRUD + GC) |
| CDS 端 SidecarDeployer | `cds/src/services/sidecar/sidecar-deployer.ts` |
| CDS 端 RemoteHost service | `cds/src/services/sidecar/remote-host-service.ts` |
| CDS 端 RemoteHost route | `cds/src/routes/remote-hosts.ts` |
| **MAP 端配对** | `prd-api/src/PrdAgent.Infrastructure/Services/InfraConnections/InfraConnectionService.cs` |
| MAP 端路由 | `prd-api/src/PrdAgent.Api/Controllers/Api/InfraConnectionsController.cs` |
| MAP 端模型 | `prd-api/src/PrdAgent.Core/Models/InfraConnection.cs` + `Interfaces/IInfraConnectionService.cs` |
| MAP 端 sidecar 路由器 | `prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/ClaudeSidecarRouter.cs` |
| MAP 端实例发现 | `prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/DynamicSidecarRegistry.cs` + `CdsSidecarSyncService.cs` |
| Sidecar 进程 | `claude-sdk-sidecar/app/main.py` + `agent_loop.py` + `profiles.py` |
| Executor 入口 | `prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs::ExecuteCliAgent_ClaudeSdkAsync` |

### 4.2 前端 UI

| 页面 | URL | 文件 | 说明 |
|---|---|---|---|
| **CDS 系统设置 → 对接 MAP** | `<cds-domain>/cds-settings#connections` | `cds/web/src/pages/cds-settings/tabs/ConnectionsTab.tsx` | 创建/管理配对密钥 |
| CDS 系统设置 → 远程主机 | `<cds-domain>/cds-settings#remote-hosts` | `cds/web/src/pages/cds-settings/tabs/RemoteHostsTab.tsx` | 登记 SSH 主机 + 一键部署 sidecar |
| **MAP 基础设施服务** | `<map-domain>/infra-services` | `prd-admin/src/pages/infra-services/InfraServicesPage.tsx` | 粘贴 CDS 密钥 / 列表 / 探活 |

### 4.3 API 端点

#### CDS 端（系统级，需 cookie 或 X-AI-Access-Key 鉴权）

```
POST   /api/cds-system/connections/issue                  生成密钥
POST   /api/cds-system/connections/accept                 接受配对（MAP 调用）
GET    /api/cds-system/connections                        列表
GET    /api/cds-system/connections/:id                    详情
POST   /api/cds-system/connections/:id/revoke             撤销
DELETE /api/cds-system/connections/:id                    删除

POST   /api/cds-system/remote-hosts                       登记主机
GET    /api/cds-system/remote-hosts                       列表
POST   /api/cds-system/remote-hosts/:id/test              SSH 测试
POST   /api/cds-system/remote-hosts/:id/deploy-sidecar    一键部署
GET    /api/cds-system/remote-hosts/:id/instance          实例发现
GET    /api/cds-system/remote-hosts/:id/deployments       部署历史

GET    /api/service-deployments/:id                       部署详情
GET    /api/service-deployments/:id/stream                SSE 日志流（afterSeq 续传）
```

#### MAP 端（需要登录态）

```
POST   /api/infra-connections/paste                       粘贴密钥完成配对
GET    /api/infra-connections                             列表
GET    /api/infra-connections/:id                         详情
DELETE /api/infra-connections/:id                         删除
POST   /api/infra-connections/:id/probe                   探活
```

#### Sidecar 端（独立进程，Bearer SIDECAR_TOKEN）

```
POST   /v1/agent/run                                      SSE 流式 agent 调用
POST   /v1/agent/cancel/:runId                            中止 run
GET    /healthz                                           存活探针
GET    /readyz                                            就绪探针（探 ANTHROPIC_API_KEY）
```

### 4.4 数据持久化

| MongoDB 集合 / 字段 | 端 | 内容 |
|---|---|---|
| `infra_connections` | MAP | InfraConnection（含加密 longToken） |
| `prd_agent_meta` 单文档 | MAP | AppSettings.MapInstanceId（lazy 创建） |
| CdsState.cdsConnections | CDS | CdsConnection（含 longToken hash） |
| CdsState.remoteHosts | CDS | RemoteHost（含 sealed SSH key） |
| CdsState.serviceDeployments | CDS | ServiceDeployment（5 阶段日志流） |
| CdsState.projects（kind='shared-service'） | CDS | 自动创建的共享服务项目 |

---

## 5. 操作步骤（用户视角）

### 5.1 一次配对

| 步 | 在哪 | 做什么 | 看到什么 |
|---|---|---|---|
| 1 | CDS dashboard | 右上角 ⚙ → CDS 系统设置 | 设置页 |
| 2 | 设置页左栏 | 运行时 → 对接 MAP | tab 内容 |
| 3 | 顶部按钮 | [+ 创建连接密钥] | 弹窗 |
| 4 | 弹窗 | 填名称（可选）→ [生成密钥] | 显示一段 base64url 密文 |
| 5 | 弹窗 | [复制到剪贴板] | toast 提示已复制 |
| 6 | 切到 MAP | 命令面板 Cmd+K → "基础设施服务" | 跳到 `<map>/infra-services` |
| 7 | 顶部按钮 | [+ 连接 CDS] | 粘贴弹窗 |
| 8 | 弹窗 | 粘贴密文 | 自动解析显示 cdsBaseUrl + cdsName + scopes（防钓鱼校验） |
| 9 | 弹窗 | [连接] | 调 `/api/infra-connections/paste` |
| 10 | 列表 | 刷新看到一条新条目，status=已连接 | partner=cds，显示 cdsBaseUrl + projectId |

整个过程**没有任何字段需要手填**（除了可选的 connection 名）。

### 5.2 部署 Sidecar 到主机（独立流程）

| 步 | 在哪 | 做什么 |
|---|---|---|
| 1 | CDS dashboard | 设置 → 运行时 → 远程主机 |
| 2 | [+ 新增主机] | 填 host / SSH user / 私钥 PEM / 标签 |
| 3 | 列表行 [试管图标] | 测试连接（真 SSH echo） |
| 4 | 列表行 [火箭图标] | 部署 Sidecar dialog |
| 5 | dialog | 填镜像 / 端口 / env（含 ANTHROPIC_API_KEY） |
| 6 | [开始部署] | dialog 切换为 SSE 进度抽屉 |
| 7 | 5 阶段日志 | connecting → installing → verifying → registering → running |
| 8 | 列表「实例」列 | 显示 `host:7400 · running` |

### 5.3 业务自动消费

只要前面两步都做了，**无需任何额外操作**：

```
MAP 端 prd-api 启动 →
  CdsSidecarSyncService 30s 拉一次 active connections →
  对每条 connection，GET {cdsBaseUrl}/api/projects/<projectId>/instances →
  把返回的 instances 加入 DynamicSidecarRegistry →
  ClaudeSidecarRouter 路由到健康实例 →
  业务调用 sidecar /v1/agent/run
```

业务节点配 `executorType=claude-sdk` 即可走这条链路。

---

## 6. 预计结果

| 检查项 | 在哪看 | 期望 |
|---|---|---|
| 配对成功 | CDS 列表 | 该条目 status=active，partnerName 显示 MAP 实例名 |
| 配对成功 | MAP 列表 | 新条目 status=active，partnerBaseUrl 显示 CDS 域名 |
| 实例发现 | MAP prd-api 日志 | 30s 内出现 `[CdsDiscovery] refreshed N sidecar instance(s) from CDS` |
| 路由器接通 | 调 `<map>/api/agent-tools/list -H 'X-Sidecar-Token:<token>'` | 200 + 工具列表 |
| 真业务调用 | 工作流跑 `executorType=claude-sdk` 节点 | SSE 流式吐出 LLM 文本 |

---

## 7. 测试方法

### 7.1 单测（已通过）

| 范围 | 文件 | 数量 |
|---|---|---|
| 配对状态机 | `cds/tests/services/connection/pairing-service.test.ts` | 13 |
| RemoteHost CRUD + 加密 | `cds/tests/services/sidecar/remote-host-service.test.ts` | 9 |
| Sidecar 部署工具（脱敏 / 防注入） | `cds/tests/services/sidecar/sidecar-deployer-utils.test.ts` | 12 |
| 主系统现有 | 主仓库 vitest | 1202 全绿 |
| 主系统 navCoverage | `prd-admin/src/lib/__tests__/navCoverage.test.ts` | 5 |

### 7.2 沙箱端到端 demo（已跑过）

```bash
# Terminal 1: 起 sidecar
cd claude-sdk-sidecar
SIDECAR_TOKEN=demo \
ANTHROPIC_API_KEY=<your-key> \
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
uvicorn app.main:app --host 127.0.0.1 --port 7401

# Terminal 2: 跑端到端 demo
cd cds && pnpm install
SIDECAR_PORT=7401 SIDECAR_TOKEN=demo MINI_CDS_PORT=9991 \
npx tsx scripts/mvp-demo.ts
```

预期输出：5 步全过 + DeepSeek 流式吐出"柳絮轻飘，花开满径。"+ token usage 24/9。

### 7.3 真人验收清单

正式环境（建议 noroenrn.com 或自建）：

- [ ] 把 noroenrn.com 切到本分支并 self-update / 重启
- [ ] 浏览器登录 CDS dashboard
- [ ] 进系统设置 → 运行时 → 对接 MAP，点 [+ 创建连接密钥]
- [ ] 复制密钥
- [ ] 浏览器另开 tab 访问 MAP `<map>/infra-services`，登录
- [ ] 点 [+ 连接 CDS]，粘贴
- [ ] 检查弹窗显示出来的 cdsBaseUrl 等同于 noroenrn.com（防钓鱼）
- [ ] 点 [连接]
- [ ] 两端列表都看到一条 active connection
- [ ] CDS 端 projects 列表自动多了一个 kind=shared-service 的项目
- [ ] CDS 端登记一台 SSH 主机 + 部署 sidecar
- [ ] 30s 后 MAP 端 `<map>/api/agent-tools/list` 能拿到该 sidecar 的工具

---

## 8. 链路追踪问题与修复

### 8.1 已修复 bug

#### B-1（高）`mapXxx` vs `partnerXxx` 字段错配 — 配对会永远失败

**症状**：MAP 端发的 body 字段名是 `mapBaseUrl/mapId/mapName`，CDS routes 读的是 `partnerBaseUrl/partnerId/partnerName`，导致 CDS 永远拿到空字符串 → 报 `partner_info_missing` → 配对失败。

**修复**：`cds/src/routes/cds-system-connections.ts:125-135` 加协议字段映射，优先读 `mapXxx`，回退兼容 `partnerXxx`：

```ts
const partnerId = String(body.mapId || body.partnerId || '');
const partnerName = String(body.mapName || body.partnerName || '');
const partnerBaseUrl = String(body.mapBaseUrl || body.partnerBaseUrl || '');
```

13 个单测继续全绿。

### 8.2 已知问题（中风险）

#### K-1 longToken 一次性签发，partner 落库失败无重发

**场景**：CDS 已 active 这条 connection 并签了 longToken；MAP 端 IDataProtector 加密落库时挂了（极罕见，比如 Mongo 闪崩），用户看到"连接失败"但 CDS 端是 active。下次 MAP 重新粘贴同密钥会被拒（`pairing_token_used`）。

**缓解**：用户在 CDS 端手动 revoke 那个孤儿 connection，重新生成密钥。文档化（本节）。

**长期方案**：spec v1.1 加 `POST /:id/rotate-long-token`（接口已预留，逻辑待补）。

#### K-2 paste 端未强校验 cdsBaseUrl 必须 HTTPS

**场景**：恶意 MAP 用户构造 `cds-connect:v1:` 密钥，cdsBaseUrl 写 `http://malicious.com`，pairingToken 在 HTTP 明文传输被嗅探。

**缓解**：spec §5 已要求 UI 二次确认 base URL；MAP 后端接 paste 时可加 HTTPS 强校验（除 localhost）。当前 v1 未加。

**记录到** `doc/debt.cds.agent.sdk-executor.md` 待补。

#### K-3 mapName 硬编码 "prd-agent"

**场景**：多 MAP 实例并存时 CDS 端看到的 partnerName 都一样，区分不开。

**缓解**：AppSettings 加 `MapDisplayName` 字段。

---

## 9. 已落地能力 vs 后续路线

### 9.1 已落地

| 能力 | 状态 |
|---|---|
| 协议 spec v1 | done |
| CDS 端 issue/accept/revoke 路由 | done |
| CDS 端 ConnectionsTab UI（创建/复制/列表/撤销） | done |
| CDS 端 RemoteHostsTab（登记主机 / 测连 / 一键部署 / SSE 进度） | done |
| MAP 端 paste/list/probe/delete 路由 | done |
| MAP 端 InfraServicesPage（连接 CDS 弹窗 / 列表 / 探活） | done |
| MAP 端 DynamicSidecarRegistry + 30s 同步 | done |
| Sidecar 协议 + 上游切换（cc-switch / DeepSeek / Kimi / GLM） | done |
| 单测覆盖 | 1202+34 全绿 |
| 字段映射 bug | 已修 |

### 9.2 后续（按优先级）

| ID | 内容 | 优先级 | 触发条件 |
|---|---|---|---|
| F-1 | 真主机端到端验收（noroenrn.com 切本分支） | P0 | 用户抽空 |
| F-2 | longToken rotate 接口 | P1 | 上线前 |
| F-3 | paste 端 HTTPS 强校验 | P1 | 上线前 |
| F-4 | mapName 走 AppSettings.MapDisplayName | P2 | 多 MAP 实例时 |
| F-5 | 反向 webhook（CDS → MAP 推 instance-changed） | P2 | 减少 MAP 轮询 |
| F-6 | shared-service Project 多主机部署 UI | P2 | 实际多副本时 |
| F-7 | 蓝绿 / 滚动升级 / 回滚 | P3 | 业务量上来 |
| F-8 | Executor 接口非标 partner（k8s / nomad / cli-adapter） | P3 | 接入新平台时 |
| F-9 | claude-sdk 节点 admin UI 配置面板 | P2 | PM/QA 用之前 |
| F-10 | docker-compose 部署策略 | P3 | 多容器协作 |

---

## 10. 关联文档

| 文档 | 用途 |
|---|---|
| `doc/spec.cds.map-pairing-protocol.md` | 协议契约（剪贴板格式 / handshake / 安全模型 / 未来扩展） |
| `doc/design.cds.agent.sdk-executor.md` | claude-sdk 执行器设计 |
| `doc/debt.cds.agent.sdk-executor.md` | claude-sdk 子模块债务台账 |
| `doc/guide.cds.agent.sdk-quickstart.md` | sidecar 三步无脑配置 + 上游切换 |
| `cds/scripts/mvp-demo.ts` | 沙箱端到端可执行验证脚本 |
| `claude-sdk-sidecar/README.md` | sidecar 协议详情 |

---

## 11. 历史背景

- **2026-04-27**：用户问"如何接 Claude Code SDK"，敲定 sidecar + LLM Gateway 并行而非取代
- **2026-05-04**：claude-sdk Executor 落地（DeepSeek 实测流式响应"柳絮轻飘，花开满径。"）
- **2026-05-05**：用户要求"无脑配置"，零配置自启 + Anthropic-compatible 上游切换落地
- **2026-05-06**：sidecar 部署归 CDS 决策；shared-service ProjectKind + RemoteHost 模型 + SidecarDeployer 5 阶段引擎
- **2026-05-07**：用户提出"剪贴板配对"体验，spec v1 + 双端实施 + 字段错配 bug 修复
- **2026-05-07** 用户要求文档沉淀，本文档为 SSOT 主篇

---

## 12. 给"想验收"的人最快路径

```
你想验什么          走哪条
─────────────────────────────────────────────────────────
看协议长什么样     →  doc/spec.cds.map-pairing-protocol.md §2 + §3
看代码改了哪些      →  本文档 §4
看怎么操作          →  本文档 §5
看应该看到什么      →  本文档 §6
看自己怎么跑         →  本文档 §7.2 沙箱 demo
跑正式环境           →  本文档 §7.3 真人验收清单
看哪些没做           →  本文档 §9.2
看为什么这么做       →  本文档 §1 + §2
```
