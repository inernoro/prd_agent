| feat | prd-api | 知识库跨节点同步支持二进制附件：导出带 peerAttachment 元信息，接收方下载并重传重建附件条目，实现真正一篇不差 |
| feat | prd-api | peer-sync 二进制条目幂等键 peerSourceAttachmentUrl，已下载且字段无变化时廉价跳过，避免重复下载 |
| fix | prd-api | peer-sync 漂移签名纳入附件标识，修复仅二进制文件变化时误报「已同步」 |
| docs | doc | debt.peer-sync 标记原 #1（二进制附件跨节点）已实现，新增 B1-B3 残留边界 |
| fix | prd-api | peer-sync 二进制幂等叠加文件大小校验（同 URL 换字节也重下），漂移签名纳入 size（Bugbot Medium） |
| fix | prd-api | peer-sync 文本条目转二进制时清理被替换的 ParsedPrd，消除孤儿解析文档（Bugbot Medium） |
