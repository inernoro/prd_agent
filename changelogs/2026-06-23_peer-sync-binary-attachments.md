| feat | prd-api | 知识库跨节点同步支持二进制附件：导出带 peerAttachment 元信息，接收方下载并重传重建附件条目，实现真正一篇不差 |
| feat | prd-api | peer-sync 二进制条目幂等键 peerSourceAttachmentUrl，已下载且字段无变化时廉价跳过，避免重复下载 |
| fix | prd-api | peer-sync 漂移签名纳入附件标识，修复仅二进制文件变化时误报「已同步」 |
| docs | doc | debt.platform.peer-sync 标记原 #1（二进制附件跨节点）已实现，新增 B1-B3 残留边界 |
| fix | prd-api | peer-sync 二进制幂等叠加文件大小校验（同 URL 换字节也重下），漂移签名纳入 size（Bugbot Medium） |
| fix | prd-api | peer-sync 文本条目转二进制时清理被替换的 ParsedPrd，消除孤儿解析文档（Bugbot Medium） |
| fix | prd-api | peer-sync 二进制导出携带规范 sourceId（源头身份）与本地 url 分离，修复 both 双向回流时两侧身份错位、永不收敛（Codex P1 / Bugbot） |
| fix | prd-api | peer-sync MetaEqual 剥离 peerSourceAttachmentUrl 键，避免接收方单边写入导致每次重同步误判已变化反复重写（Bugbot Medium） |
| fix | prd-api | peer-sync 附件下载边读边卡 50MB 上限（流式），防对端不带 Content-Length 时缓爆内存（Codex P2） |
| fix | prd-api | peer-sync 二进制幂等/签名改用「源头侧 att.Size」（存入 peerSourceAttachmentSize 元数据）同口径比对，修复 entry.FileSize≠att.Size 时无限重下循环（Bugbot Medium） |
| fix | prd-api | peer-sync 文本条目转二进制时改写 ContentIndex 为附件提取文本（或清空），消除旧正文残留导致的搜索误命中（Bugbot/Codex Medium） |
| docs | doc | debt.platform.peer-sync 新增 B4：可提取文本文件（PDF/DOCX）仅同步正文不同步原件，留待结构性合并文本/二进制 apply 路径 |
| fix | prd-api | peer-sync 文本覆盖时清空残留 AttachmentId（与二进制路径清 DocumentId 对称），避免同条目同时挂文档+附件引用（Bugbot Medium） |
| fix | prd-api | peer-sync 二进制条目变更检测纳入 ContentType/FileSize/提取文本，文件未变仅元数据变也落更新；文件未变时刷新已存在 Attachment.ExtractedText/FileName，消除陈旧提取文本（Bugbot Medium x2） |
| fix | prd-api | peer-sync 附件下载支持相对 URL：按 sourceBaseUrl 解析对端本地存储返回的相对地址（/api/...），使自托管/本地存储节点也能同步文件（Codex P2） |
| fix | prd-api | peer-sync 文件条目被改成（空）文本时强制走全量更新，避免空文本与文件兜底空串哈希相等导致条目卡在旧文件不转文本（Codex P2） |
| fix | prd-api | peer-sync 形态切换只认「纯二进制」(有 AttachmentId 且无 DocumentId)，双形态条目(PDF/DOCX 同时有文档+附件)文本更新不再误清 AttachmentId，修复 both 回流丢原件（Codex P1 回归修复） |
