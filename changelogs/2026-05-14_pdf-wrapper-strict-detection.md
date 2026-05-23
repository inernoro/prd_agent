| fix | prd-api | 收紧 PDF 包装站识别条件（entry=index.html + 恰好2文件 + 一个 index.html + 一个根目录 .pdf），避免把含 PDF 子文件的正常 ZIP 站误判为包装站（Codex P2 #612） |
| fix | prd-admin | 前端 isPdfSite 同步严格匹配 wrapper 形状 |
