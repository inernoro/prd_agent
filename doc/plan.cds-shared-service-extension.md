# plan.cds-shared-service-extension

| 字段 | 内容 |
|---|---|
| 版本 | 0.1.0 |
| 状态 | 提案（draft，待 CDS 团队评审） |
| 责任人 | Claude Code |
| 关联 | `doc/plan.sidecar-server-management.md`、`.claude/rules/cds-auto-deploy.md`、`doc/design.claude-sdk-executor.md` |

---

## 0. 一句话定位

给 CDS 加一个新的 ProjectKind: `shared-service`，把"长生命周期共享基础设施服务"（claude-sdk sidecar / Embedding / 转录 / 任何未来的 Agent 旁路服务）的部署 + 健康监控 + 升级回滚都收口到 CDS。主系统（prd-api / prd-admin）只负责"消费侧路由"。

---

## 1. 为什么要做

### 1.1 现状割裂

CDS 现有能力是 **branch-preview 模型**（每个 git 分支一套预览容器，用完就删）。

但 claude-sdk sidecar 不是 branch-preview：

- 跑在固定服务器、长生命周期
- 不绑定 git 分支，绑定 git tag/release
- 不需要预览域名 + slug 转换
- 但需要 SSH 部署 / 健康监控 / 日志拉取 / 升级回滚

如果不让 CDS 做，主系统就要重写一份 SSH 部署引擎（见 `plan.sidecar-server-management.md`），这是浪费。

### 1.2 复用而非新造

CDS 已有：

| 能力 | 当前用途 | shared-service 复用方式 |
|---|---|---|
| GitHub App webhook | branch push -> 自动部署预览 | release tag -> 自动部署/升级 sidecar |
| Topology 视图 | 显示分支与服务依赖 | 显示 shared-service 实例分布（多 region 多副本） |
| 健康检查 + check-run | PR Checks 状态 | shared-service 实例的 /healthz |
| docker compose 编排 | 起预览栈 | 远程主机起 sidecar 容器 |
| Public URL | 预览域名 | sidecar 公网入口（如果需要） |
| 自更新预检 | self-update 防熔断 | sidecar 升级时同样防御 |

只缺：**远程 SSH 主机注册** + **shared-service ProjectKind 分类**。

---

## 2. 责任划分（核心）

```
+===============================================================+
|  CDS（部署/编排/健康/升级）                                    |
+===============================================================+
|                                                                 |
| - RemoteHost 登记（SSH 凭据加密存储）                           |
| - shared-service Project 类型（绑定 git tag/release）           |
| - 部署引擎（SSH + docker compose）                              |
| - 健康监控 + 日志聚合                                           |
| - 蓝绿/滚动升级、回滚                                           |
| - REST API: GET /api/shared-services / instances （主系统消费） |
|                                                                 |
+================== ↓ instance discovery API ==================+
                    ↓
+===============================================================+
|  prd-api（消费侧 / 路由）                                       |
+===============================================================+
|                                                                 |
| - ClaudeSidecarRouter（已有，路由 + 健康探针）                  |
| - DynamicSidecarRegistry（新：定期拉 CDS API 同步实例列表）     |
| - profile / 上游切换（已有，留主系统）                          |
| - LlmRequestLogs 写入（已有）                                   |
|                                                                 |
+===============================================================+
                    ↓
+===============================================================+
|  prd-admin（业务可视化）                                        |
+===============================================================+
|                                                                 |
| - 实例列表只读视图（拉 CDS + 主系统两端数据合并）               |
| - 路由策略配置（tag-weighted / sticky / 加权）                  |
| - 业务级监控（active runs / 平均延迟 / 错误率，主系统视角）     |
| - "去 CDS 部署"按钮（深链跳转 CDS dashboard）                   |
|                                                                 |
+===============================================================+
```

**关键边界**：任何"操作远程主机 / 起停容器 / 推 docker compose"代码都不在 prd-api / prd-admin。

---

## 3. CDS 端要做的扩展

### 3.1 数据模型扩展

```typescript
// 现有 Project 加 kind 字段
interface Project {
  id: string;
  name: string;
  kind: 'branch-preview' | 'shared-service';   // ← 新
  // branch-preview 字段：githubRepoFullName / autoDeploy / branches
  // shared-service 字段：
  releaseTag?: string;                          // 当前部署的版本
  remoteHostIds?: string[];                     // 部署目标主机
  composeTemplate?: string;                     // docker-compose 模板（可含变量）
  envSchema?: Record<string, EnvVarSpec>;       // 必填/可选环境变量声明
}

// 新集合: remote_hosts
interface RemoteHost {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyEncrypted: string;
  tags: string[];               // ['prod','asia','europe']
  ownerProjectIds: string[];    // 哪些 project 可以部署到这台主机
  createdAt: Date;
}

// 新集合: service_deployments （取代 branch deployment 的另一类）
interface ServiceDeployment {
  id: string;
  projectId: string;
  hostId: string;
  releaseTag: string;
  status: 'pending'|'connecting'|'installing'|'verifying'|'running'|'failed';
  phase?: string;
  seq: number;                  // SSE 续传
  containerHealthOk: boolean;
  lastHeartbeatAt?: Date;
  startedAt: Date;
  finishedAt?: Date;
  logs: DeploymentLogEntry[];
}
```

### 3.2 新 API

```
GET  /api/projects?kind=shared-service              列出所有共享服务项目
POST /api/projects/:id/deploy?host=:hostId&tag=:t   部署到指定主机
GET  /api/projects/:id/instances                    实例发现（主系统消费）
                                                    -> [{host, port, healthy, version, region}]
GET  /api/projects/:id/instances/stream             SSE 推送实例状态变化

POST /api/remote-hosts                              登记主机
GET  /api/remote-hosts                              列出主机
POST /api/remote-hosts/:id/test                     测连接
```

### 3.3 UI 扩展

CDS dashboard 增加 ProjectKind tab：

```
┌────────────────────────────────────────────────────────┐
│ CDS Dashboard                                           │
├────────────────────────────────────────────────────────┤
│ [分支预览]  [共享服务]  [远程主机]  [设置]               │
└────────────────────────────────────────────────────────┘

[共享服务] tab：
+ 项目卡片：claude-sdk-sidecar  (release v0.2.1)
  └ 实例: prod-sg-1  running  v0.2.1  uptime 3d
  └ 实例: prod-us-1  running  v0.2.1  uptime 3d
  └ 实例: dev-local  running  v0.2.0  uptime 1h
  [部署 v0.2.2 ↗]  [滚动升级]  [回滚]

[远程主机] tab：
+ 主机列表：name | host | tags | 当前实例数 | actions
```

### 3.4 部署流程（与现有 branch-preview 对称）

```
GitHub release tag v0.2.2 -> webhook -> CDS dispatcher
   -> 找出所有 kind=shared-service 且 trackTags 匹配的 project
   -> 对每个 project, 滚动部署到 ownerHosts[]
       -> 旧实例不下线（除非配 strategy=replace）
       -> 新实例起 -> /healthz 通 -> 主系统 instance discovery 拿到
       -> 流量自然切（路由器健康检查接管）
       -> 旧实例下线
```

---

## 4. 主系统侧改动（最小）

### 4.1 prd-api

新增 `IDynamicSidecarRegistry` 实现：

```csharp
public interface IDynamicSidecarRegistry {
    Task<IReadOnlyList<SidecarInstanceConfig>> GetActiveInstancesAsync(CancellationToken ct);
}
```

实现：
1. 启动时合并 `appsettings.Sidecars[]` + CDS API 返回
2. `IClaudeSidecarRouter.PickInstance` 改读这个 registry
3. HostedService 每 30s 拉一次 CDS `/api/projects/claude-sdk-sidecar/instances`
4. CDS 不可达时降级到 appsettings 静态配置（已有逻辑）

零代码涉及部署/SSH/容器编排。

### 4.2 prd-admin

只读视图（本次先做占位页面，CDS 完成后接入真实数据）。

---

## 5. 实施分期

**Phase 1（CDS 端，估算 1 周）**
- Project.kind 字段 + RemoteHost 登记
- 部署引擎（SSH + docker compose）
- /api/projects/:id/instances 实例发现 API
- CDS dashboard 「共享服务」tab

**Phase 2（主系统侧，估算 1 天）**
- `IDynamicSidecarRegistry` + 拉取 hosted service
- `prd-admin` 占位页接入真实数据（替换当前 wip placeholder）

**Phase 3（CDS 端，估算 0.5 周）**
- 滚动/蓝绿升级
- release tag webhook
- 主机 + 实例的健康监控告警

**Phase 4（增强）**
- SSH 证书认证（CA 签发）
- 多 region 路由智能化
- 业务级埋点（错误率 / 延迟）

---

## 6. 风险点

| 风险 | 缓解 |
|---|---|
| CDS 团队需要重构核心模型（Project.kind 引入） | 小步走：先加字段不动旧逻辑，新 tab 走全新代码路径 |
| shared-service 的部署语义与 branch-preview 不同 | 抽象不同 deployer 实现，共享 transport 层 |
| 主系统 -> CDS API 网络故障 | DynamicSidecarRegistry 兜底走静态配置 |
| 实例发现协议变化 | API 加版本前缀 `/api/v1/projects/...` |

---

## 7. 决策点

需要 CDS 团队确认：

1. **是否接受 ProjectKind 扩展为 shared-service**？
2. **是否接受新增 RemoteHost 集合**（独立于现有 CDS 资源池）？
3. **API contract** 主系统消费的 `/api/projects/:id/instances` 字段是否合适？
4. 估算工作量与排期。

如果 CDS 评审通过，本 plan 转 in-progress；否则按 `plan.sidecar-server-management.md` 的 P0 路径解冻自做。
