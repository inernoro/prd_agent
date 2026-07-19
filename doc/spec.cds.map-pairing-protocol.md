# CDS 与 MAP 配对协议 · 规格

> **版本**：v1.1 | **日期**：2026-07-17 | **状态**：已落地

## 0. 定义

MAP 与独立 CDS 实例通过一次性剪贴板密钥建立双向信任。CDS 负责项目、部署和实例发现，MAP 保存加密后的长期连接凭据并消费实例。用户只执行“在 CDS 复制”和“在 MAP 粘贴”，不手填 base URL、projectId 或长期 token。

## 1. 用户流程

1. CDS 管理员在系统设置创建配对密钥。
2. CDS 显示带协议前缀的一次性文本和过期时间。
3. 用户在 MAP 基础设施连接页粘贴文本并确认解析出的 CDS 名称和地址。
4. MAP 后端调用 CDS accept；CDS 激活连接、准备 shared-service 项目并签发长期 token。
5. MAP 加密保存 token，开始健康探测与实例发现。

浏览器不解析、保存或转发长期 token；所有握手由双方服务端完成。

## 2. 剪贴板密文格式（v1）

格式为 `cds-connect:v1:<base64url(JSON)>`。payload 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 固定为 `1` |
| `cdsBaseUrl` | 是 | 用户可访问且 MAP 服务端可连接的 CDS 地址 |
| `cdsId` | 是 | CDS 稳定实例标识 |
| `cdsName` | 否 | UI 显示名 |
| `pairingToken` | 是 | 一次性随机 token，只在 TTL 内有效 |
| `issuedAt`、`expiresAt` | 是 | 签发和过期时间，默认十分钟 |
| `scopes` | 是 | CDS 同意 MAP 使用的能力范围 |
| `hint` | 否 | sidecar 支持和默认端口等非权威提示 |

约束：

- 使用 base64url 且不带 padding，协议版本通过前缀分流。
- payload 可读但不能包含 `cdsLongToken`、SSH key 或模型密钥。
- pairing token 在 CDS 只保存 hash，accept 成功或过期后不可重用。
- MAP 必须向用户展示解析出的 CDS 地址，防止把恶意地址当作可信实例。

## 3. HTTP Handshake

### 3.1 CDS 发放密钥

`POST /api/cds-system/connections/issue` 接收可选名称、scopes 和 1 至 60 分钟 TTL，返回 connectionId、clipboardText 和 expiresAt。CDS 创建 `pending-pairing` 记录并保存 pairing token hash。

### 3.2 MAP 粘贴并调用 CDS accept

MAP 接口 `POST /api/infra-connections/paste` 只接收 clipboardText。MAP 解析后向 `{cdsBaseUrl}/api/cds-system/connections/accept` 发送：

| 字段 | 说明 |
| --- | --- |
| `pairingToken` | 剪贴板中的一次性 token |
| `mapBaseUrl`、`mapId`、`mapName` | MAP 的稳定身份与显示信息 |
| `projectIntent` | 默认请求 `shared-service` 项目及显示名 |

CDS accept 必须原子完成：校验 hash、TTL 和未使用状态；消费 token；创建或复用符合意图的项目；签发长期 token；激活连接；保存 MAP 身份。响应包含 connectionId、长期 token 及过期时间、projectId、instanceDiscoveryUrl 和可选 deploy stream 模板。

MAP 收到响应后用 `IDataProtector` 加密长期 token，保存连接、CDS 身份、projectId、scopes 和发现地址，再向前端返回脱敏视图。

### 3.3 失败语义

| 场景 | HTTP | errorCode |
| --- | ---: | --- |
| 格式错误 | 400 | `clipboard_invalid_format` |
| 不支持的版本 | 400 | `clipboard_version_not_supported` |
| token 过期或已使用 | 410 | `pairing_token_expired` / `pairing_token_used` |
| token 不存在 | 404 | `pairing_token_not_found` |
| 同一 CDS 已连接 | 409 | `connection_duplicate` |
| CDS 网络不可达 | 502 | `cds_unreachable` |

错误响应不得包含 token、hash、内部连接串或远端响应正文中的敏感值。

### 3.4 实例发现

MAP 的 `DynamicSidecarRegistry` 从 active 连接读取 PartnerBaseUrl 和 InstanceDiscoveryUrl，解密长期 token 后请求实例列表。每个实例至少包含 deploymentId、hostId、host、port、healthy 和 version；MAP 映射为 `Source=cds-pairing` 的动态实例。

CDS 配对实例是外部执行池，是否可路由由实例健康、adapter/profile 兼容和 MAP 策略共同决定，不能只因连接 active 就视为可执行。

## 4. 持久化契约

### 4.1 MAP

`infra_connections` 保存 Partner、PartnerId、PartnerBaseUrl、LongTokenEncrypted、LongTokenExpiresAt、ProjectId、InstanceDiscoveryUrl、Scopes、Status 和最近探测结果。长期 token 不返回浏览器。

### 4.2 CDS

`CdsState.cdsConnections` 或现行等价 store 保存连接状态、scopes、pairing token hash/TTL、long token hash/TTL、partner 身份、projectId 和审计时间。明文 token 只在签发响应中出现一次。

## 5. 安全模型

- 一次性 token 默认十分钟，成功后立即失效。
- 长期 token 只保存 hash 或加密值，并支持撤销和轮换。
- 鉴权只信任 token，不信任请求自报 mapId、partnerId 或 scope。
- MAP 和 CDS 日志统一脱敏，禁止输出 clipboardText、长期 token 或请求 Authorization。
- 删除连接必须同时停止后续探测；项目和运行资源是否删除需单独确认。
- 重复 accept、并发 accept 和 token 轮换必须有状态机测试。

## 6. 责任划分

| 能力 | MAP | CDS |
| --- | --- | --- |
| 用户与业务路由 | 权威 | 不负责 |
| 主机、部署、容器健康和回滚 | 消费结果 | 权威 |
| 实例发现 | 消费 | 提供 |
| Agent 运行选择 | 权威 | 提供候选实例 |
| 连接 token | 加密保存长期 token | 保存 token hash并签发 |
| 审计 | 记录消费与失败 | 记录签发、激活、轮换和撤销 |

## 7. 未来扩展

v2 可以增加反向实例变更通知和其他 executor partner，但必须使用新协议版本或能力协商。Kubernetes、Nomad 或 CLI adapter 不得伪装为 CDS v1；它们需实现等价的 accept、listInstances、deploy 和 stream 契约。

## 8. v1 实现来源

- CDS：`cds/src/services/connection/pairing-service.ts`、`cds/src/routes/cds-system-connections.ts`
- MAP：`InfraConnectionsController` 与 InfraConnections services
- UI：CDS ConnectionsTab 与 MAP InfraServicesPage
- 测试：CDS pairing-service 状态机和 MAP 连接测试

## 9. 非目标

- 多 partner 的通用协议标准化。
- 通过剪贴板传递长期凭据。
- 浏览器直连 CDS accept。
- 将 active 连接等同于可用 official SDK runtime。
