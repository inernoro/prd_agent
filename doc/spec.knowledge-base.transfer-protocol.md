# MAP 知识库传输协议（MAP-KBTP v1） · 规格

> **版本**：v1.1 | **日期**：2026-06-22 | **状态**：已落地
> 负责模块：prd-api（PeerSync + DocumentStoreSyncResource）、prd-admin（同步中心）
> 关联：`design.platform.peer-sync.md`（节点配对设计）、`spec.cds.compose-contract.md`（同类对外契约写法）

---

## 1. 管理摘要（30 秒看懂）

**MAP 知识库传输协议（MAP-KBTP）是一套让两个 MAP 实例之间、或第三方系统与 MAP 之间，安全互传「知识库」整库数据的开放协议。**

它解决一件事：把一个知识库（含目录树、正文、图片、标签、归属、置顶/主文档、排序偏好）从 A 节点搬到 B 节点，并且：

- **幂等**：传 100 次和传 1 次结果一致（靠每条记录的稳定「血缘 ID」对齐，不重复建）。
- **去重廉价**：内容没变就跳过，且**不做任何重活**（先比内容哈希，命中即跳过，不下载图片）。
- **图片归属对端**：正文里的图片传过去后，重传到**接收方自己的对象存储（COS）**，不再外链源站。
- **可删除对齐**：支持「强制对齐」——以一边为准，删掉另一边多出来的条目（数据破坏性，需二次确认）。
- **可演进**：传输包带版本号 + `extras` 透传字段，任一方升级加字段，老节点不丢数据不报错。
- **可审计**：每次传输落一条运行台账，「同步中心」按「进行中 / 发出去 / 收进来 / 历史」展示。

一句话：**别人接入本系统，照这份协议实现 6 个 HTTP 端点 + 1 个 bundle 格式，就能和 MAP 互传知识库。**

---

## 2. 协议分层

```
┌─ 配对层（信任）  两节点握手交换 sharedSecret，详见 design.platform.peer-sync.md
│   HMAC-SHA256 签名鉴权：X-Peer-Node / X-Peer-Ts / X-Peer-Sign
├─ 传输层（搬运）  本协议主体：bundle 格式 + 6 个端点 + 方向语义
└─ 资源层（落库）  ISyncableResource 实现，把 bundle 映射到本地领域模型
```

第三方系统要接入，只需实现「配对层 + 传输层」的对端端点，资源层按自己的存储落库即可。

---

## 3. 数据契约：SyncResourceBundle

跨节点传输的载荷（HTTP body，camelCase JSON，不落库）。SSOT：`PrdAgent.Core/Sync/SyncContracts.cs`。

```jsonc
{
  "schemaVersion": 1,                 // 发起方 schema 版本
  "resourceType": "document-store",   // 资源类型（kebab-case）
  "item": {                           // 条目级元信息（= 一个知识库）
    "key": "<storeId>",              // 稳定条目键（跨节点对齐，建议保留同一 id）
    "name": "验收报告",
    "description": "...",
    "tags": ["..."],
    "ownerUserName": "蒋云峰",       // 归属对齐：先用户名
    "ownerEmail": "x@y.com",         // 再邮箱，都未命中归到操作者
    "createdAt": "2026-01-01T...",
    "updatedAt": "2026-06-01T...",
    "templateKey": "acceptance-report-v2",
    "primaryEntryLineage": "<lineage>",        // 主文档（按血缘，跨节点翻译）(v1.1)
    "pinnedEntryLineages": ["<lineage>"],      // 置顶（按血缘）           (v1.1)
    "defaultSortMode": "created-desc",         // 排序偏好                 (v1.1)
    "extras": { }                    // 未知字段透传（向下兼容）
  },
  "records": [                        // 条目内记录（每篇文档 / 文件夹）
    {
      "lineageId": "<stable-id>",    // 稳定血缘 ID（幂等 upsert 对齐键）
      "parentLineageId": "<id|null>",// 父记录血缘（树形）
      "isFolder": false,
      "title": "远程验收短视频教程",
      "summary": "...",
      "contentType": "text/markdown",
      "fileSize": 1234,
      "tags": ["短视频"],
      "metadata": { "syncLineageId": "...", "peerSourceContentHash": "..." },
      "content": "正文…（文件夹/二进制为 null）",
      "contentHash": "<sha256(content)>",  // 源内容哈希，接收方先比它再决定是否做重活 (v1.1)
      "sortOrder": 1.5,                    // 目录手动排序                          (v1.1)
      "category": "教程",                   // 分类                                  (v1.1)
      "createdAt": "...", "updatedAt": "...", "lastChangedAt": "...",
      "extras": { }
    }
  ]
}
```

(v1.1) = 本次（2026-06-15）新增字段，老节点缺省时按默认兜底，不破。

---

## 4. 端点（节点间，[AllowAnonymous] + HMAC 验签）

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/api/peer-sync/handshake` | 配对握手（校验配对码，建互信），见 design.platform.peer-sync.md |
| GET  | `/api/peer-sync/ping` | 连通 + 验签自检 |
| GET  | `/api/peer-sync/capabilities` | 本节点支持的资源类型 + schema 版本 |
| POST | `/api/peer-sync/resources/{type}/signature` | 取条目内容签名（廉价变更检测，不传正文） |
| POST | `/api/peer-sync/resources/{type}/export` | 导出条目 bundle（对端 pull 用） |
| POST | `/api/peer-sync/resources/{type}/apply` | 应用 bundle（对端 push 用） |

用户侧（[Authorize]，本端用户发起）：

| 方法 | 路由 | 说明 |
|------|------|------|
| GET  | `/api/peer-sync/nodes` | 已配对对端节点 + 资源能力 |
| GET  | `/api/peer-sync/resources/{type}/items` | 本端可发送的条目 |
| POST | `/api/peer-sync/transfer` | 发起互传（见 §5） |
| GET  | `/api/peer-sync/runs` | 同步运行台账（同步中心数据源） |

---

## 5. 方向与对齐语义（最重要）

`POST /transfer` body：`{ nodeId, resourceType, itemIds[], direction?, align?, mode?, preserveTimestamps?, rewriteAssetLinks? }`

### 5.1 普通方向（不删数据）

| direction | 含义 | apply 模式 |
|-----------|------|-----------|
| `push` | 本地 → 对端 | overwrite（覆盖共享条目，两侧新增都留，**不删**） |
| `pull` | 对端 → 本地 | overwrite |
| `both` | 先推后拉，推不通不拉（防丢本地编辑） | overwrite |

### 5.2 强制对齐 `align`（数据破坏性，需前端二次确认）

`align` 一旦设置即覆盖 `direction`/`mode`：

| align | 中文 | 等价 | 删除行为 |
|-------|------|------|---------|
| `remote` | 远端为准 | pull + **mirror** | 删除**本地**在对端不存在的条目 |
| `local`  | 本地为准 | push + **mirror** | 删除**对端**在本地不存在的条目 |
| `both`   | 同时对准 | both + overwrite | **不删**，仅合并新增/更新（最安全） |

**mirror（镜像）是本协议唯一的删除路径**：接收方 apply 完 upsert 后，删除目标端「本次 bundle 里没有的血缘」对应的条目。普通 push/pull/both 永不删。实现见 `DocumentStoreSyncResource.ApplyRecordsAsync` 的 `mirror` 分支。

> 这条解决了「右边删到 109、左边还是 145」——普通同步只增不删，要拉齐数量必须走强制对齐。

---

## 6. 去重规则（解决「显示跳过却转很久」）

两层哈希，按血缘 ID 配对后逐条判定：

1. **廉价层（首选）**：bundle 每条 record 带 `contentHash = sha256(源正文)`。接收方比对本地存的 `metadata.peerSourceContentHash`，**命中即跳过，零开销**（不加载本地正文、不下载图片）。
2. **重活层（仅未命中时）**：加载本地正文 + 重传图片 + 比对最终哈希。

> v1.0 的 bug：重活层在「得出跳过结论之前」就把图片全下载了 → 用户看到「跳过但转很久」。v1.1 把廉价层的源哈希**随包发送**，接收方先比再决定是否做重活，no-op 同步即时返回。

---

## 7. 图片 / 资源归属（以接收方 COS 为准）

- `rewriteAssetLinks=true`（默认）时，接收方对正文里的图片：**下载源图 → 存进接收方自己的对象存储（COS） → 把链接改写成接收方域名**。
- 允许的源域名白名单：接收方配置的 `R2/TENCENT_COS/CDN_BASE_URL/ASSET_PUBLIC_BASE_URL` + 本次传输的 `sourceBaseUrl`。
- 每篇首次落地必做一次本地化；之后靠源哈希命中不再重复下载。
- 结果计数：`assetsRewritten` / `assetRewriteFailed`，在同步中心可见。

---

## 8. 运行台账（同步中心数据源）

每次传输每条目落一条 `peer_sync_runs`（`PrdAgent.Core/Models/PeerSyncRun.cs`）：

- 先落 `status=syncing`（**进行中**可被并发轮询看到 → 按钮「动起来」），完成回填 `synced/skipped/error`。
- 字段：`origin`（outgoing 发出去 / incoming 收进来）、`direction`、`created/updated/skipped/deleted/failed`、`assetsRewritten`、`durationMs`、对端节点、触发人。
- `GET /api/peer-sync/runs?resourceType=document-store[&itemId=]`：按 `origin/direction/status` 分组成「进行中 / 发出去 / 收进来 / 历史」。

---

## 9. 向下兼容规则

- **已知字段**按本节点 schema 落库。
- **未知字段**原样进 `extras`，不丢不报错。
- **缺字段**用本节点默认兜底（老 bundle 兼容）。
- **版本高于本节点**：尽力 apply 已知字段 + 保留 extras，结果回 `partial=true`。

---

## 10. 第三方接入方法（教程）

要让你的系统能与 MAP 互传知识库：

1. **实现配对**：暴露 `POST /handshake` 接受 MAP 的配对码，存下 `sharedSecret`；所有后续请求用 `HMAC_SHA256(sharedSecret, "{METHOD}\n{path}\n{ts}\n{sha256(body)}")` 验签（头 `X-Peer-Node/X-Peer-Ts/X-Peer-Sign`，时间偏移 > 5 分钟拒绝）。
2. **实现 export**：`POST /resources/document-store/export`，按 §3 格式吐 bundle（每条带 `contentHash`）。
3. **实现 apply**：`POST /resources/document-store/apply`，按 §5/§6/§7 落库（血缘幂等 + 哈希去重 + 图片本地化），mirror 模式按 §5.2 删除。
4. **实现 signature**：`POST /resources/document-store/signature`，返回整库内容签名供漂移检测。
5. **能力声明**：`GET /capabilities` 返回 `[{ resourceType:"document-store", supportsBidirectional:true, schemaVersion:1 }]`。
6. **归属对齐**：apply 时按 `ownerUserName → ownerEmail → 操作者` 三级兜底归属。

MAP 侧的参考实现就是 `DocumentStoreSyncResource` + `PeerSyncController`，可直接对照。

---

## 11. 风险与债务

- **图片大文件**：单图上限 25MB，超限计 failed（不阻塞其余）。
- **mirror 误删**：强制对齐有数据破坏性，前端必须二次确认（列出将删条目数）；建议先 `both` 同时对准再视情况 mirror。
- **三方实现差异**：`signature` 算法若两端不一致会导致永远「不同步」；接入方需对齐 §6 哈希口径。
- 详见 `debt.knowledge-base.md`。
