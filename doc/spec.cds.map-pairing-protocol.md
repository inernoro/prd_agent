# spec.cds.map-pairing-protocol

| 字段 | 内容 |
|---|---|
| 版本 | v1 |
| 状态 | v1 MVP 已落地（CDS project instance discovery + MAP dynamic sidecar registry） |
| 责任人 | Claude Code |
| 关联 | `doc/plan.cds-shared-service-extension.md`、`doc/design.claude-sdk-executor.md` |

---

## 0. 一句话定义

**MAP 平台**（prd-admin / prd-api）和 **CDS**（独立部署平台）之间通过"剪贴板配对密钥"建立双向信任连接。配对完成后：CDS 自动准备项目和资源 → MAP 通过这条连接消费部署能力（实例发现 / 路由 / SSE 日志）。未来任何继承 Executor 接口的部署平台都通过同一协议接入。

## 1. 用户体验流（terminating diagram）

```
[CDS 端]                                 [MAP 平台]
1. CDS 系统设置 → 对接 MAP → [+ 创建连接密钥]
   弹窗显示一段密文 + [复制到剪贴板]
                    ↓ 用户复制
                    ↓ 切到 MAP
                                         2. 基础设施服务 → [+ 连接 CDS]
                                            弹窗一个大 textarea，粘贴
                                            [连接]
                                         ↓ MAP 后端解析密文
                                         ↓ POST cds_base_url/.../accept
3. CDS 验证 + 创建 shared-service 项目
   返回 { connection_id, cds_long_token,
          project_id, instance_discovery_url }
                                         ↓ MAP 加密落库 + 返回 UI
                                         4. UI 列表显示 "已连接 CDS-X"
                                            状态: 已连接
```

**关键体验承诺**：用户除了「点复制」+「点粘贴」外**不输入任何字段**。所有 base URL / token / project id / 健康检查间隔等都通过协议自动协商。

## 2. 剪贴板密文格式（v1）

```
cds-connect:v1:<base64url(JSON)>
```

`<base64url(JSON)>` 解码后是：

```jsonc
{
  "version": 1,
  "cdsBaseUrl": "https://noroenrn.com",     // CDS 公开访问 URL
  "cdsId": "cds-uuid-xxx",                  // CDS 实例的稳定标识
  "cdsName": "noroenrn-prod",               // CDS 显示名（可选，给 UI 看）
  "pairingToken": "pt_<random32>",          // 一次性配对令牌
  "issuedAt": "2026-05-06T18:30:00Z",
  "expiresAt": "2026-05-06T18:40:00Z",      // 默认 10 分钟 TTL
  "scopes": [                                // CDS 同意 MAP 后续用这些能力
    "shared-service:deploy",
    "instance:read",
    "deployment:stream"
  ],
  "hint": {                                  // 可选，给 MAP 一些环境提示
    "supportsSidecar": true,
    "defaultSidecarPort": 7400
  }
}
```

设计要点：

- **prefix 校验**：MAP 端用 `startsWith('cds-connect:v1:')` 快速判断。未来 v2 改 prefix `cds-connect:v2:`，老 MAP 直接报"不支持的版本"。
- **base64url**（不是 base64）：避免 `+` `/` 在 URL/聊天工具里被破坏；不带 `=` padding。
- **JSON**（不是 JWT）：明文可读，便于运维 cat 出来 debug；token 安全靠 pairing-token 一次性 + TTL，不靠加密。
- **不含 `cdsLongToken`**：长效凭据通过后续 handshake 派发，剪贴板里只有"一次性配对凭据"，泄露也无法利用（10 分钟内一次失效）。

## 3. HTTP Handshake

### 3.1 CDS 端：发放密钥

```
POST /api/cds-system/connections/issue
Body:
  {
    "name": "for noroenrn map",      // 可选，CDS 内部识别用
    "scopes": [...],                 // 可选，默认 ['shared-service:deploy', 'instance:read', 'deployment:stream']
    "ttlMinutes": 10                 // 可选，1~60
  }
Resp 201:
  {
    "connectionId": "conn_xxx",       // 待激活
    "pairingToken": "pt_xxx",
    "clipboardText": "cds-connect:v1:<base64url(...)>",
    "expiresAt": "..."
  }
```

CDS 内部建一条 `CdsConnection` 记录，状态 `pending-pairing`，写 `pairingTokenHash`。

### 3.2 MAP 端：粘贴 + 调用 CDS accept

```
POST /api/infra-connections/paste              [MAP 端 API]
Body:
  {
    "clipboardText": "cds-connect:v1:..."
  }
```

MAP 后端解析密文 → POST 到 CDS：

```
POST {cdsBaseUrl}/api/cds-system/connections/accept     [对端 CDS API]
Body:
  {
    "pairingToken": "pt_xxx",
    "mapBaseUrl": "https://prd-agent.example.com",       // MAP 的公开访问 URL
    "mapId": "map-uuid",                                 // MAP 实例标识
    "mapName": "prd-agent prod",                         // 显示名
    "projectIntent": {
      "kind": "shared-service",
      "name": "sidecar-pool",
      "displayName": "Claude SDK Sidecar Pool"
    }
  }
Resp 200:
  {
    "connectionId": "conn_xxx",
    "cdsLongToken": "ct_<random32>",                     // 长效凭据，MAP 后续调 CDS 用
    "cdsLongTokenExpiresAt": "...",                      // 默认 1 年
    "projectId": "proj_xxx",                             // CDS 创建的 shared-service 项目
    "instanceDiscoveryUrl": "/api/projects/proj_xxx/instances",
    "deployStreamUrlTemplate": "/api/service-deployments/{id}/stream"
  }
```

CDS 端 accept 行为：
1. 校验 `pairingToken` SHA256 hash 匹配某个 pending connection 且未过期未使用
2. 标记 pairingToken 为 used（一次性）
3. 创建 shared-service 项目（kind='shared-service'）
4. 生成 cdsLongToken，hash 存到 connection 记录
5. 设置 connection.status='active'
6. 写入对端信息（mapBaseUrl, mapId, mapName）
7. 返回响应

MAP 端收到响应后：
1. `IDataProtector` 加密 cdsLongToken → 入库 `infra_connections` 集合
2. 同时把 `mapId` / `mapBaseUrl` / `partner: 'cds'` 信息记录
3. 返回 UI

### 3.3 失败语义

| 场景 | HTTP | errorCode | 用户提示 |
|---|---|---|---|
| 密文格式错 | 400 | `clipboard_invalid_format` | "密钥格式不对，重新复制粘贴" |
| 协议版本太新 | 400 | `clipboard_version_not_supported` | "MAP 版本太老，请先升级" |
| pairingToken 过期 | 410 | `pairing_token_expired` | "密钥已过期（10 分钟），重新生成" |
| pairingToken 已使用 | 410 | `pairing_token_used` | "密钥已被使用，重新生成" |
| pairingToken 不存在 | 404 | `pairing_token_not_found` | "密钥无效" |
| MAP 已连同一 CDS | 409 | `connection_duplicate` | "已有同 CDS 连接，先删除旧的" |
| 网络不通 | 502 | `cds_unreachable` | "无法访问 CDS：{detail}" |

### 3.4 MAP 消费实例发现（2026-05-13 MVP）

MAP 后台 `DynamicSidecarRegistry` 周期读取 active CDS 连接：

1. 从 `infra_connections` 取 `PartnerBaseUrl`、`InstanceDiscoveryUrl`。
2. 解密 `cdsLongToken`，以 `Authorization: Bearer <longToken>` 调用：

```
GET {PartnerBaseUrl}{InstanceDiscoveryUrl}
```

3. CDS 返回：

```jsonc
{
  "projectId": "proj_xxx",
  "instances": [
    {
      "deploymentId": "dep_xxx",
      "hostId": "host_xxx",
      "host": "10.0.0.8",
      "port": 7400,
      "healthy": true,
      "tags": ["prod"],
      "version": "v0.2.0"
    }
  ]
}
```

4. MAP 转成 `DynamicSidecarInstance`，`Source="cds-pairing"`。

`cds-pairing` 实例是外部执行池：sidecar 自己持有 Anthropic key，因此 MAP 本地
`ClaudeSdkExecutor.Enabled=false` 时仍允许路由到这些实例。sidecar Bearer token
由 `ClaudeSdkExecutor:CdsDiscovery:SharedSidecarToken` 提供，未设置时退回
`DefaultSidecarToken`。

## 4. 双方持久化数据

### 4.1 MAP（`infra_connections` MongoDB 集合）

```csharp
public class InfraConnection {
    public string Id;                          // 本地 id
    public string Partner;                     // "cds"，未来 "k8s" / "nomad"
    public string PartnerName;                 // CDS 实例显示名（来自 CDS）
    public string PartnerId;                   // CDS 实例稳定 ID
    public string PartnerBaseUrl;              // 配对后协商的 base URL
    public string LongTokenEncrypted;          // IDataProtector 加密
    public DateTime LongTokenExpiresAt;
    public string ProjectId;                   // CDS 给 MAP 创建的 shared-service 项目
    public string InstanceDiscoveryUrl;        // GET 实例列表的相对路径
    public List<string> Scopes;                // 这条连接允许的能力
    public string Status;                      // 'active' | 'token-rotating' | 'revoked' | 'unreachable'
    public DateTime CreatedAt;
    public DateTime UpdatedAt;
    public DateTime? LastProbedAt;             // 最近一次健康探测
    public bool? LastProbeOk;
}
```

### 4.2 CDS（`CdsState.cdsConnections`）

```typescript
interface CdsConnection {
  id: string;
  name: string;                       // 自己看的标识
  status: 'pending-pairing' | 'active' | 'revoked';
  scopes: string[];

  // 配对态字段（active 后失效）
  pairingTokenHash?: string;          // SHA256 hash，明文不存
  pairingExpiresAt?: string;

  // 激活态字段
  longTokenHash?: string;             // SHA256 hash
  longTokenExpiresAt?: string;
  longTokenIssuedAt?: string;
  partnerKind: 'map';                 // 未来 'cli' / 'other'
  partnerId?: string;
  partnerName?: string;
  partnerBaseUrl?: string;
  projectId?: string;                 // 创建的 shared-service 项目

  createdAt: string;
  activatedAt?: string;
  lastUsedAt?: string;
}
```

## 5. 安全模型

| 威胁 | 缓解 |
|---|---|
| 剪贴板密钥被截获后被第三方使用 | TTL 10 分钟 + 一次性 + 仅含 pairing token，长效 token 不在剪贴板里 |
| 密钥重放 | accept 标记 `used`，第二次 410 |
| MAP 假装是别的 MAP 注入 partnerId | accept 后 partnerId/partnerBaseUrl 由 CDS 自己记录，鉴权时只信任 longToken hash 不信任 partnerId 自报 |
| longToken 泄露 | rotate API（`POST /:id/rotate-long-token`）给老 token 一段宽限期，新 token 写过去 |
| MAP 端 longToken 被偷 | IDataProtector 加密 + 不返前端（API 返回视图脱敏） |
| 钓鱼：假冒 CDS 给的密钥指向恶意 base URL | 用户复制密钥源头是 CDS 自己 UI，base URL 写明在密钥里。MAP 端 UI 在 paste dialog 显示解析出的 base URL 让用户二次确认 |

## 6. 双方责任划分

| 责任 | MAP | CDS |
|---|---|---|
| 用户登记主机/SSH 凭据 | 不做 | 做（已实现） |
| 部署执行（docker pull/run） | 不做 | 做（SidecarDeployer） |
| 健康检查容器 | 不做 | 做 |
| 实例发现（运行时给主系统看） | 消费 | 提供 GET /api/projects/:id/instances |
| 业务路由 / 调度 / 流量 | 做（ClaudeSidecarRouter） | 不参与 |
| 日志聚合 / 升级 / 回滚 | 不做 | 做 |
| 凭据存储 | 仅 longToken（IDataProtector） | SSH 私钥 + 自身 token（sealToken） |

## 7. 未来扩展（v2+）

### 7.1 MAP 支持非标 executor

`InfraConnection.Partner` 取值扩展：

| Partner | 含义 | InstanceDiscoveryUrl |
|---|---|---|
| `cds` | 标准 CDS 实例（v1） | CDS 协议路径 |
| `k8s` | Kubernetes 集群 | `kubectl get pods` 抽象 |
| `nomad` | Nomad cluster | Nomad API |
| `agent-cli` | 用户自部署的 CLI 适配器（非标） | `executor:GetInstances()` |

只要对端实现下述 minimal interface 之一，MAP 就能消费：

```typescript
interface ExecutorPartner {
  // 必须
  acceptPairing(req): { longToken, instances: string };
  listInstances(token): { host, port, healthy, version }[];

  // 可选
  deploy(spec): { deploymentId, streamUrl };
  streamDeployment(id): SSE;
}
```

### 7.2 CDS 支持任意 executor 接口的程序作为部署目标

CDS 的 `RemoteHost` 抽象升级为 `DeployTarget`：

```typescript
type DeployTarget =
  | { kind: 'ssh-host', sshHost, sshUser, ... }
  | { kind: 'k8s-namespace', cluster, namespace, ... }
  | { kind: 'nomad-job', cluster, jobspec, ... }
  | { kind: 'cli-adapter', adapterUrl, adapterToken, ... };  // 用户自托管的 CLI executor
```

`SidecarDeployer.runDeployment` 按 `target.kind` 分派到对应的 `DeployerStrategy` 实现：

```typescript
interface DeployerStrategy {
  connecting(target): Promise<void>;
  installing(target, spec): Promise<void>;
  verifying(target, spec): Promise<void>;
}
```

### 7.3 数据回传统一接口

任何 executor 完成部署后通过统一回传：

```
POST {map_callback_base_url}/api/infra-connections/:id/instance-changed
Header: X-Connection-Token: <map_callback_token>  // accept 时 MAP 给 CDS 的反向 token
Body:
  {
    "event": "deployed" | "removed" | "health_changed",
    "instance": { host, port, healthy, version, deployedAt }
  }
```

MAP 收到后即时刷新本地 registry，**无需轮询**。

## 8. v1 落地清单

| 块 | 文件 |
|---|---|
| **CDS 协议端** | `cds/src/types.ts` 加 CdsConnection；`cds/src/services/connection/pairing-service.ts`（新）；`cds/src/routes/cds-system-connections.ts`（新 issue / accept / list / delete / rotate-long-token） |
| **CDS UI** | `cds/web/src/pages/cds-settings/tabs/ConnectionsTab.tsx`（新，运行时分组） |
| **MAP 协议端** | `prd-api/.../Models/InfraConnection.cs`、`Services/InfraConnections/`（新）、`Controllers/Api/InfraConnectionsController.cs`（新 paste / list / delete） |
| **MAP UI** | `prd-admin/src/pages/infra-services/InfraServicesPage.tsx`（从 wip 占位改造为真实功能） |
| **测试** | CDS vitest 配对状态机；MAP 沙箱手测 |

## 9. 不在 v1 范围

- `rotate-long-token`（接口预留，逻辑 v1.1）
- 反向 webhook（CDS → MAP 的 instance-changed 推送，v1 走 MAP 轮询）
- v2 版本协议（仅在 v1 prefix 上加 `cds-connect:v2:` 前缀，遇到时报"不支持"）
- 多 MAP 共用一个 CDS 的并发租户隔离（CDS 项目级隔离已天然支持，但 UI/告警未做）
