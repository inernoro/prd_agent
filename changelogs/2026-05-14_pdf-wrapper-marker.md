| fix | prd-api | HostedSite 加 WrappedAssetType marker，CreateFromZipAsync 接收并持久化；PDF 包装站识别只看 marker 不看 ZIP 文件形状，避免误判用户上传的"index.html + .pdf"两文件 ZIP（Codex P2 #612） |
| fix | prd-admin | isPdfSite 改读后端 wrappedAssetType marker；HostedSite 类型加 wrappedAssetType 字段 |
| test | prd-api | 补 LongTokenExpiresAt 让 HasRecentHealthyProbe 测试跟上 main 871ab45 改动 |
