| fix | prd-api | 新增对象存储真实写入、内部读取、公开访问与清理就绪探针，修复 Cloudflare R2 上传签名，持久化完整音频校准意图并让完成态重试自动重建转录任务 |
| fix | prd-api | 为本地 SHA 与自定义键资产统一生成精确公开 URL 并阻断目录穿越，让 Nginx 前端同源代理参与就绪校验 |
| fix | prd-admin | 为 Vite 本地开发入口补充本地资产同源代理，避免头像与录音 URL 落入 SPA fallback |
| fix | prd-api | 统一 auto 存储供应商与公开 URL 的运行时解析，并用会话 outbox 自动恢复终态提交后遗漏的完整录音转录任务 |
| fix | prd-api | 强制降级校准任务读取完整音频，并阻止晚到实时文本覆盖已生成的完整转录摘要与索引 |
| perf | prd-api | 为录音转录 outbox、对象归档认领、过期清理与分片读取补充可执行 MongoDB 索引清单 |
| test | prd-api | 强制测试项目发现并让录音归档测试使用独立 MongoDB，测试宿主默认隔离正式云存储变量，补齐终态中断恢复、本地公开读取、安全路径和三环境存储合同测试 |
| ops | cds | 在根级与兼容配置中固化本地 local、CDS Cloudflare R2、正式环境腾讯 COS 三套互斥存储合同，清除跨环境默认值并绑定业务就绪探针 |
| fix | cds | 修复引导脚本失败状态被清理 trap 覆盖，以及 macOS 规范路径差异导致迁移 worktree 别名漏检的问题 |
