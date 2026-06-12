# 系统级跨节点互传（Peer Sync）

> 状态：draft（v1 落地中）
> 负责模块：prd-api（PeerNode + PeerSync）、prd-admin（系统互联设置 + 发送到对端）
> 关联：`design.server-authority.md`、`rule.app-identity.md`、知识库现有 `DocumentStoreSyncController`

---

## 1. 管理摘要（30 秒看懂）

MAP 经常需要在「测试环境」与「正式环境」之间互传数据（最典型是知识库）。今天知识库已经能跨环境同步，但**配对方式是让用户手动复制一段 `skblink_` 链接（内含对端地址 + 永久令牌）粘到另一个环境**——用户要在两个站点之间来回倒腾密钥，既麻烦又有泄露风险，而且每个应用各搞各的。

本方案把「**两个 MAP 节点之间的信任关系**」从"用户每次粘贴"上升为"**管理员配一次，全系统复用**"：

1. **管理员在「设置 → 系统互联」里把对端节点配好一次**（输入对端地址 + 一次性配对码，两个节点自动握手交换长期密钥）。从此两个环境互相认识，用户再也不用碰密钥。
2. **用户在任意应用（首发知识库）右上角点「发送到 →」，选一个已配好的对端节点**，勾选要传的数据（单个 / 多个知识库），点确认即可完成拷贝。
3. **按用户名对齐归属**：传过去的数据自动归到对端的同名用户名下，找不到同名用户时让用户选择归属，不会串号。
4. **知识库支持双向同步**（你改我改都能合），其它应用先支持单向发送/拉取。
5. **向下兼容**：传输包带版本号，对端遇到不认识的新字段会原样保留在 `extras` 里，将来任一方升级加字段，老节点不会丢数据、不会报错。

一句话：**把"用户在两个站点之间手动倒密钥"换成"管理员配一次、用户一键发送"，并抽象成一套所有应用都能接入的通用互传框架。**

---

## 2. 背景与问题

### 2.1 现状（知识库已有的跨环境同步）

知识库现有 `DocumentStoreSyncController` 已经相当完整：

- 配对分 `local`（同环境两库）/ `remote`（跨环境 HTTP）。
- 支持 `push` / `pull` / `both` 三种方向，`both` 用签名快照判断"哪侧改了"，冲突时本地为准、两侧新增都保留。
- 幂等 upsert：每条目带稳定「血缘 ID」(`metadata.syncLineageId`)，重复同步按血缘匹配更新而非重建。
- 远端鉴权：每个库一个永久 `SyncToken`，对端请求头带 `X-Sync-Token`。

**这套同步引擎本身要保留**，它解决的是"内容怎么搬、怎么去重、怎么判方向"——这部分做得好。

### 2.2 痛点（只在"配对/认证"这一层）

| 痛点 | 后果 |
|------|------|
| 配对靠用户手动复制 `skblink_` 链接（含 BaseUrl + 永久 Token）粘到对端 | 密钥在用户手里流转，可能泄露；操作繁琐，要在两个站点来回切 |
| 信任关系是"库级令牌"，每个库一把、每次配对都要重来 | 没有"系统认识系统"的概念，10 个库要倒 10 次 |
| 每个应用要复用这种能力都得自己实现一套 token + 远端端点 | 无法横向复用，缺陷/视觉等想要也得重造轮子 |

### 2.3 目标

- **系统级配对**：管理员配一次对端节点，建立两节点间的长期互信，用户零接触密钥。
- **统一框架**：抽象 `ISyncableResource`，任何应用实现接口即可接入互传；知识库做第一个、且支持双向。
- **数据一致性**：传输保持时间戳、附件引用、文件内容；按用户名对齐归属。
- **演进安全**：版本协商 + 未知字段保留，向下兼容、未来加字段不破。

### 2.4 非目标（v1 不做）

- 不做实时增量推送（仍是用户触发 / 已有的后台轮询节奏）。
- 不做附件二进制大文件的跨节点流式传输（v1 同知识库现状：传正文 + 引用元数据，二进制资产走各自对象存储，列入债务）。
- 不做三个以上节点的网状拓扑编排（只做点对点配对，可配多个对端）。

---

## 3. 核心概念与角色

| 概念 | 说明 |
|------|------|
| **节点（Node）** | 一个独立部署的 MAP 实例（如"测试环境"、"正式环境"）。每个节点有一个稳定的 `nodeId`（首启生成，存系统设置）。 |
| **对端节点（PeerNode）** | 本节点记录的"我认识的另一个节点"：含对端 baseUrl、对端 nodeId、双方共享的 `sharedSecret`。配对成功后两个节点各存一条互指的 PeerNode。 |
| **配对（Handshake）** | 管理员动作：A 粘贴 B 生成的连接串 → A 调 B 的握手端点 → B 校验一次性配对码、生成 sharedSecret、落 PeerNode(A) → 返回 secret → A 落 PeerNode(B)。此后双方互信。 |
| **可同步资源（SyncableResource）** | 一种能被互传的业务数据类型（如 `document-store`）。由 `ISyncableResource` 实现，声明能力（单向/双向）、导出、导入、签名。 |
| **互传（Transfer）** | 用户动作：选对端节点 + 选资源条目 + 选方向 → 发起 push / pull / 双向。 |

---

## 4. 用户场景

### 场景 A：管理员首次打通两个环境
1. 正式环境管理员进入「设置 → 系统互联」，点「生成我的连接串」，得到一段一次性连接串（3 天内有效，使用一次后失效）。
2. 测试环境管理员进入同一页面，点「添加对端」，粘贴正式环境的连接串，点「添加」。
3. 两节点自动握手，列表里出现彼此，状态「已连接」。**之后所有用户都能用，无需再配。**

### 场景 B：用户把知识库发到正式环境
1. 用户在知识库列表勾选 1 个或多个库 → 右上角「发送到 →」。
2. 弹窗列出已配好的对端节点，选「正式环境」。
3. 选方向：发送（本地→对端）/ 拉取（对端→本地）/ 双向同步。
4. 点确认 → 进度条逐库推进 → 完成提示「新增 X / 更新 Y / 跳过 Z」。

### 场景 C：知识库双向协作
- 用户在测试改了 3 篇、正式改了 2 篇，点「双向同步」→ 共享条目以发起方为准、两侧各自新增都保留（沿用现有 both 语义）。

---

## 5. 核心能力

### 5.1 节点配对与互信

握手成功后，双方各存一条 `PeerNode`，含相同的 `sharedSecret`（32 字节随机，仅存本地、永不出现在 URL / 日志 / 前端）。后续所有跨节点数据请求用 **HMAC-SHA256 签名**鉴权，不再传明文令牌：

```
X-Peer-Node: {发起方 nodeId}
X-Peer-Ts:   {unix 毫秒}
X-Peer-Sign: HMAC_SHA256(sharedSecret, "{METHOD}\n{path}\n{ts}\n{sha256(body)}")
```

对端按 `X-Peer-Node` 找到对应 PeerNode 取出 secret 验签，时间戳偏移超 5 分钟拒绝（防重放）。配对码一次性，默认 3 天有效，握手成功即失效。

### 5.2 通用资源框架（ISyncableResource）

```csharp
public interface ISyncableResource
{
    string ResourceType { get; }              // "document-store"
    string DisplayName { get; }               // "知识库"
    bool SupportsBidirectional { get; }       // 知识库 true，其它 false

    // 发起方：列出本节点当前用户可发送的条目
    Task<IReadOnlyList<SyncItemSummary>> ListItemsAsync(SyncActor actor, CancellationToken ct);

    // 计算/发送两阶段（compute-then-send）：导出一个条目为 bundle
    Task<SyncResourceBundle> ExportAsync(string itemId, SyncActor actor, CancellationToken ct);
    Task<string> ComputeSignatureAsync(string itemId, CancellationToken ct);

    // 接收方：把 bundle 落到本节点，按用户名对齐归属
    Task<SyncApplyOutcome> ApplyAsync(SyncResourceBundle bundle, SyncActor actor, SyncApplyMode mode, CancellationToken ct);
}
```

`SyncResourceRegistry` 反射收集所有实现，按 `ResourceType` 索引。新增资源 = 加一个实现类 + DI 注册，端点零改动。

### 5.3 版本协商与向下兼容

每个 bundle 头带 `schemaVersion`（整数）。接收方规则：

- **已知字段**：按本节点 schema 映射落库。
- **未知字段**：原样收进每条记录的 `Extras`（`Dictionary<string, JsonElement>`）字典保留，落库到 metadata 命名空间 `peer.extras.*`，不丢弃、不报错。
- **缺字段**：用本节点默认值兜底（向下兼容旧节点发来的老 bundle）。
- **版本高于本节点能处理**：仍尽力 apply 已知字段 + 保留 extras，并在结果里回 `partial: true` + 提示"对端版本较新，部分字段已保留但未解释"。

这样任一节点升级加字段，老节点既不丢数据也不崩。

### 5.4 用户名对齐归属

bundle 里每个"作者/拥有者"字段带**用户名 + 邮箱**（不带 userId，userId 跨环境无意义）。接收方：

1. 按 `username` 精确匹配本节点用户 → 命中即归到该用户。
2. 未命中按 `email` 匹配 → 命中即归。
3. 都未命中 → 归到**发起本次 apply 的操作者**（带标记 `peer.originalAuthor` 留痕），不创建影子用户（v1 保守，避免脏号），并在结果里列出"N 条作者未对齐，已归到你名下"。

---

## 6. 架构

```
节点 A（测试）                                  节点 B（正式）
┌──────────────────────────┐                  ┌──────────────────────────┐
│ 设置→系统互联             │   握手(配对码)    │ /api/peer-sync/handshake  │
│ AdminPeerNodesController  │ ───────────────► │ 校验码→生成 secret→存PeerNode│
│ 存 PeerNode(B)+secret     │ ◄─────────────── │ 返回 secret + nodeId       │
├──────────────────────────┤                  ├──────────────────────────┤
│ 用户「发送到 B」          │  HMAC 签名请求    │ /api/peer-sync/...        │
│ PeerSyncController(发起)  │ ───────────────► │ PeerSyncController(接收)   │
│  ↳ ISyncableResource.Export│  bundle(schemaV) │  ↳ 验签→Registry→Resource │
│  ↳ push: 调对端 apply     │                  │  ↳ ApplyAsync 按用户名对齐 │
│  ↳ pull: 调对端 export    │                  │                          │
└──────────────────────────┘                  └──────────────────────────┘
         共享同步引擎：DocumentStoreSyncService（BuildBundle/ApplyBundle 抽出复用）
```

发起方与接收方是**同一份 PeerSyncController 代码**（每个节点既能发又能收）。发起方用 HMAC 调对端的接收端点；接收端点 `[AllowAnonymous]` + 验签中间逻辑鉴权。

### 6.1 与现有知识库同步引擎的关系

现有 `DocumentStoreSyncController` 的 `BuildBundleAsync` / `ApplyBundleAsync` / `ComputeSignatureAsync` 抽到 `DocumentStoreSyncService`（Infrastructure），供：
- 旧的 `X-Sync-Token` 路径继续用（保留向后兼容，不动现有用户的链接）。
- 新的 `DocumentStoreSyncResource`（实现 `ISyncableResource`）复用同一引擎。

旧的 `skblink_` 手动配对**保留**（不删），新增系统级配对作为**推荐路径**。

---

## 7. 数据设计

### 7.1 PeerNode（集合 `peer_nodes`）

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | 主键 |
| RemoteNodeId | string | 对端节点稳定 id |
| DisplayName | string | 对端展示名（"正式环境"） |
| BaseUrl | string | 对端 baseUrl（含可能的子路径前缀） |
| SharedSecret | string | 双方共享密钥（base64，仅后端可见） |
| Status | string | pending / connected / error |
| LastError | string? | 最近一次通信错误 |
| LastContactAt | DateTime? | 最近一次成功通信 |
| CreatedBy | string | 配对发起管理员 userId |
| CreatedAt / UpdatedAt | DateTime | 时间戳 |

### 7.2 节点自身标识 + 配对码

- 本节点 `nodeId` 存 `appsettings` 集合（key `peer.selfNodeId`，首次访问惰性生成）。
- 一次性配对码存 `peer_pairing_codes` 集合：`{ Id=code, ExpiresAt, Used }`，默认 3 天有效，使用一次后失效。

### 7.3 传输契约（不落库，HTTP body）

`SyncResourceBundle { schemaVersion, resourceType, item: {key,name,...,extras}, records:[{...,extras}] }`，camelCase 序列化。知识库的 records 即现有 `SyncEntryDto` 扩展 `extras` 字段。

---

## 8. 接口设计

### 管理端（[AdminController] + 新权限 `peer-sync.manage`）
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/admin/peer-nodes` | 列出已配对节点 + 本节点 nodeId |
| POST | `/api/admin/peer-nodes/pairing-code` | 生成一次性配对码 |
| POST | `/api/admin/peer-nodes` | 添加对端：填 baseUrl + 配对码，触发握手 |
| POST | `/api/admin/peer-nodes/{id}/test` | 测试连通性（HMAC ping） |
| DELETE | `/api/admin/peer-nodes/{id}` | 解除配对（本端删除，建议同时通知对端） |

### 节点间（[AllowAnonymous] + HMAC 验签）
| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/peer-sync/handshake` | 接收握手（校验配对码，建互信） |
| GET | `/api/peer-sync/ping` | 连通 + 验签自检 |
| GET | `/api/peer-sync/capabilities` | 本节点支持的资源类型 |
| POST | `/api/peer-sync/resources/{type}/signature` | 取条目签名 |
| POST | `/api/peer-sync/resources/{type}/export` | 导出条目 bundle（对端 pull 用） |
| POST | `/api/peer-sync/resources/{type}/apply` | 应用 bundle（对端 push 用） |

### 用户端（[Authorize]，发起互传）
| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/peer-sync/nodes` | 列出可发送的对端节点（用户可见，不含 secret） |
| POST | `/api/peer-sync/transfer` | 发起互传：{nodeId, resourceType, itemIds[], direction} |

---

## 9. 关联设计文档
- `design.server-authority.md`：长任务 / CancellationToken.None
- 知识库现有同步：`DocumentStoreSyncController`（保留 token 路径）

## 10. 风险与债务
- **二进制附件跨节点**：v1 只传正文 + 引用元数据，对端无对应附件时图片可能断链 → 列入 `debt.peer-sync.md`。
- **影子用户**：v1 不创建，未对齐作者归到操作者 → 后续可加"按邮箱建影子账户"开关。
- **解除配对的对端清理**：v1 仅本端删除，对端残留 PeerNode 需对端管理员手动删 → 后续加 revoke 通知。
- **SSRF**：对端 baseUrl 必须过 `ISafeOutboundUrlValidator`（沿用知识库同步）。

## 11. 已落地能力更新（2026-06-08）

### 11.1 添加对端流程收敛为 prepare/confirm/ping

旧流程（直接 POST 对端 URL）存在"半连接状态"风险：添加失败时本端已保存 PeerNode 而对端未确认。

新流程（三步原子化）：
1. `prepare`：本端校验连接串格式，生成临时 token，不落库。
2. `confirm`：调对端握手验证，成功后双端才同时落 `PeerNode`。
3. `ping`：连通性验证（HMAC 自检）。

失败不保存半连接状态；前端添加对端收敛为单一连接串粘贴流程。
