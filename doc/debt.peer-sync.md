# 工程债务台账：系统级跨节点互传（Peer Sync）

> 类型：debt | 模块：prd-api PeerSync + prd-admin 系统互联 | 关联：doc/design.peer-sync.md

记录 v1 已知边界、后续可补项、未覆盖风险。下一次 session 接手先读这里。

## 已知边界（v1 故意不做）

| # | 边界 | 现状 | 后续方向 |
|---|------|------|---------|
| 1 | 二进制附件跨节点 | 只传知识库正文（markdown / 文本）+ 引用元数据；图片等二进制资产不随包传输，对端无对应附件时图片可能断链 | 后续走对象存储签名 URL 或附件流式传输 |
| 2 | 影子用户 | 归属对齐失败（对端无同名 username / email）时归到「操作者」（push 路径=发起用户；node-to-node apply 路径=配对管理员），不创建影子账号 | 后续加「按邮箱建影子账户」开关 |
| 3 | 解除配对的对端清理 | DELETE 仅删本端 PeerNode，对端残留记录需对端管理员手动删 | 后续加 revoke 通知对端 |
| 4 | 双向合并语义 | both = push(targetKey) 然后 pull(targetKey)，共享条目以发起方为准、两侧新增都保留；非「逐条三方合并」 | 复用现有 DocumentStoreSyncController 的签名快照三态判定可做更精细的「仅改动侧驱动」 |
| 5 | 资源覆盖面 | v1 只实现 document-store 一个 ISyncableResource（双向）；其它应用单向能力尚未接入 | 缺陷/视觉/工作流等各加一个 ISyncableResource 实现 + DI 注册即可 |
| 6 | 同步引擎重复 | DocumentStoreSyncResource 的 export/apply 算法与 DocumentStoreSyncController 的私有方法是「同算法两份代码」（为零回归风险，未抽公共引擎） | 后续抽 IDocumentStoreSyncEngine，两边共用，消除分叉风险 |
| 7 | 本节点对外地址来源 | selfBaseUrl 默认从请求 scheme+host 推断，反向代理 / 内网部署可能不可达；可在添加对端时手填 selfBaseUrl 覆盖 | 后续在系统设置固化「本节点对外地址」 |
| 8 | 进度可视化 | transfer 为同步 HTTP 一次性返回逐条结果，未做 SSE 流式进度（多库大库时等待较久，仅 spinner） | 大批量时改 Run/Worker + SSE 推进度（呼应 CLAUDE.md §6） |

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
