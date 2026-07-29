| fix | prd-api | 新增对象存储真实写入、内部读取、公开访问与清理就绪探针，修复 Cloudflare R2 上传签名，并让实时 ASR 降级后的正式归档自动排队完整音频校准 |
| test | prd-api | 强制测试项目发现并让录音归档测试使用独立 MongoDB，禁止依赖缺失时静默通过 |
| ops | cds | 固化本地 local、CDS Cloudflare R2、正式环境腾讯 COS 三套互斥存储合同并绑定业务就绪探针 |
