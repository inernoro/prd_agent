# 工程债务台账：系统级跨节点互传（Peer Sync）

> 类型：debt | 模块：prd-api PeerSync + prd-admin 系统互联 | 关联：doc/design.peer-sync.md

记录 v1 已知边界、后续可补项、未覆盖风险。下一次 session 接手先读这里。

## 已知边界（v1 故意不做）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| 1 | 二进制附件跨节点 | 已实现（2026-06-23）：导出时文件条目（无正文、走 AttachmentId）带 `Extras["peerAttachment"]`（url/mime/fileName/size/type/thumbnailUrl/extractedText）；接收方下载文件 → 重传到本节点存储 → 重建 Attachment + DocumentEntry，`peerSourceAttachmentUrl` 元数据做幂等。签名也纳入附件标识（避免仅二进制变化的伪「已同步」）。残留小边界见下方 B 系列 | — |
| 2 | 影子用户 | 归属对齐失败（对端无同名 username / email）时归到「操作者」（push 路径=发起用户；node-to-node apply 路径=配对管理员），不创建影子账号 | 后续加「按邮箱建影子账户」开关 |
| 3 | 解除配对的对端清理 | DELETE 仅删本端 PeerNode，对端残留记录需对端管理员手动删 | 后续加 revoke 通知对端 |
| 4 | 双向合并语义 | both = push(targetKey) 然后 pull(targetKey)，共享条目以发起方为准、两侧新增都保留；非「逐条三方合并」 | 复用现有 DocumentStoreSyncController 的签名快照三态判定可做更精细的「仅改动侧驱动」 |
| 5 | 资源覆盖面 | v1 只实现 document-store 一个 ISyncableResource（双向）；其它应用单向能力尚未接入 | 缺陷/视觉/工作流等各加一个 ISyncableResource 实现 + DI 注册即可 |
| 6 | 同步引擎重复 | DocumentStoreSyncResource 的 export/apply 算法与 DocumentStoreSyncController 的私有方法是「同算法两份代码」（为零回归风险，未抽公共引擎） | 后续抽 IDocumentStoreSyncEngine，两边共用，消除分叉风险 |
| 7 | 本节点对外地址来源 | selfBaseUrl 默认从请求 scheme+host 推断，反向代理 / 内网部署可能不可达；可在添加对端时手填 selfBaseUrl 覆盖 | 后续在系统设置固化「本节点对外地址」 |
| 8 | 进度可视化 | transfer 为同步 HTTP 一次性返回逐条结果，未做 SSE 流式进度（多库大库时等待较久，仅 spinner） | 大批量时改 Run/Worker + SSE 推进度（呼应 CLAUDE.md §6） |

## 后台自动同步（2026-06-22 PR #890 新增）

把「双向同步」从手动一次性升级为定期自动保持一致（PeerSyncScheduleWorker + 每库开关）。已落地防风暴五层
（每库 Mongo 租约 / 全局并发上限 / 批量上限 / 到期闸+5min 下限 / 抖动+租约自愈），手动 transfer 与自动 worker
共用同一把库级互斥租约（`TryAcquireStoreSyncLeaseAsync`，30min TTL，owner 限定释放）。遗留项：

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| A1 | 租约无心跳续租 | 固定 30min TTL，覆盖单库最坏同步耗时（两阶段 HTTP 各 120s + 资源重传）。若出现 >30min 的超大库，超时后锁可被另一发起方抢走 → 同库并发 | 同步期间周期性续租（heartbeat），持短 TTL 但活着就续 |
| A2 | force-align mirror 删除未级联 | 镜像删除对端缺失条目时只删 DocumentEntry（+可能的解析文档），未清其 sync 日志 / view events / 内联评论 / 版本 / mentions / agent runs / 附件 —— 与 `DocumentStoreController.DeleteEntry` 的级联不一致，留孤儿数据。仅手动 force-align 路径触发（自动同步只 Overwrite 不删，不受影响） | 抽 `DeleteEntry` 的级联清理为共享 helper（跨 Api/Infrastructure 层），mirror 删除复用 |
| A3 | apply 不清理「源已清空」的 primary/pins/defaultSortMode | 源库清空主文档 / 移除全部置顶 / 清空默认排序后，apply 的 overwrite/mirror 路径只在「解析到新值 / 字段非 null」时才写 → 目标残留旧 PrimaryEntryId / PinnedEntryIds / DefaultSortMode（含 mirror 刚删的条目 id）。注：per-record 的 sortOrder/category 已纳入变更检测+签名（已修）；本项专指**库级**这三个「null=已清空 还是 null=旧节点没传」无法区分的字段 | 需先在协议层用「null=旧节点字段缺失 / 空=显式清空」哨兵区分，否则旧节点同步会误清目标；区分后 overwrite/mirror 显式清空 |

| A4 | 库级互斥锁未覆盖 incoming apply | `TryAcquireStoreSyncLeaseAsync` 已让**出站**两条路径（手动 `POST /transfer` + 自动 worker）互斥，但**入站** `RemoteApply`（对端 push 进来）直接 `ApplyAsync`，未取同一把锁。故「本地正在出站同步某库」与「对端同时 push 该库进来」仍可交错写。自动同步恒 Overwrite（幂等 upsert，最终收敛、不丢数据）；唯一真风险是入站 mirror 删除与本地写交错，而 mirror 仅手动 force-align（用户二次确认）触发 | RemoteApply 对 document-store 也取同一把锁；需处理「目标库尚不存在（首次接收）」时不存在锁文档、不应误判冲突的边界 |

A2/A3/A4 都是 **手动 force-align/mirror 或入站 apply 路径**的既有/完整性问题，与本次新增的「自动出站同步」无关
（自动同步恒 Overwrite、绝不删条目，幂等收敛），故未在 PR #890 内仓促改动（需跨层 / 协议级 / 安全端点改造），单列于此。

## 二进制附件跨节点（2026-06-23 新增，原 debt #1）

文件类条目（PNG / yaml / pdf 等，无正文、走 AttachmentId）现已随包跨节点：导出带 `peerAttachment` 元信息 →
接收方经 SSRF 校验下载 → 重传到本节点存储 → 重建 Attachment + DocumentEntry，`peerSourceAttachmentUrl` 做幂等。
缩略图尽力本地化，签名纳入附件标识。残留小边界：

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| B1 | 单文件大小上限 50MB | 超过即跳过该条（failed 计数），避免超大文件拖垮同步 | 需要更大文件时改分片 / 直传对象存储签名 URL |
| B2 | mirror 删除二进制条目不删 Attachment | 镜像删除时只删 DocumentEntry，孤儿 Attachment 残留（内容寻址、无害但占空间）。与 A2 同源 | 复用 A2 的级联清理 helper 时一并处理 |
| B3 | 缩略图本地化失败置空 | 缩略图下载失败时 ThumbnailUrl 留空（不留指向对端的悬挂 URL），主文件仍正常 | 可接受；前端对无缩略图已有兜底 |

## 安全与一致性要点（已落地）

- 节点配对：一次性配对码（5 分钟 TTL）+ 握手交换 32 字节共享密钥；后续请求 HMAC-SHA256 签名（method+path+ts+sha256(body)），时间戳偏移超 5 分钟拒绝（防重放）。共享密钥永不出现在 URL / 前端 / 日志。
- SSRF：对端 baseUrl / 发起方回连地址均过 ISafeOutboundUrlValidator。
- 受信节点导出绕过按用户访问校验（SyncActor.PeerSystem），但仅在 HMAC 验签通过后；这是「系统级互信」的有意设计。
- 幂等：沿用 metadata.syncLineageId 血缘键，与旧 skblink token 路径数据互通；重复同步按血缘 upsert，内容未变跳过。
- 向下兼容：bundle / record 带 schemaVersion + Extras 字典，未知字段原样保留。

## 防自指（共享 DB / 配置错误兜底）

CDS 灰度环境下两个分支共用同一 MongoDB，导致 `appsettings.global.MapInstanceId` 在两个分支看是同一个值，
两个分支的 `selfNodeId` 因此相同。已加三层防护：

1. **握手层**：`AddPeerNode` / `Handshake` 收到 `InitiatorNodeId == selfNodeId` 直接拒绝（早期发现）。
2. **验签层**：`VerifyPeerAsync` 收到 `X-Peer-Node == selfNodeId` 即返回 401「不能与本节点自己同步（同 nodeId）」，
   即便配对记录被旁路写入也无效。
3. **用户 transfer 层**：发起 push/pull/双向时若所选节点的 `RemoteNodeId == selfNodeId` → 拒绝。

测试时可用 `PEER_NODE_ID_OVERRIDE` 环境变量强制覆盖 selfNodeId（不写回 DB），让共享 DB 部署的不同分支
互相看到对方为「不同节点」，从而走通真实握手 + HMAC + bundle 传输路径。运维场景下也可用此 env 重置节点身份。

## 验证状态（截至落地）

- 本地无 .NET SDK，后端编译走 CDS（见交付消息预览链接 / CDS check）。
- 前端 tsc / lint 见交付消息。
- 端到端「两个真实节点互传」需两套已部署环境，单分支预览无法自测双节点握手 —— 列为待真人/双环境验收项。
