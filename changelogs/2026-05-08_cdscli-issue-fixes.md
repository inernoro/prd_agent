| fix | cds | cdscli preflight：onboard 前检查 reposBase，避免创建不可部署的半成品项目（issue #537） |
| feat | cds | 新增 cdscli preflight 独立命令：检查 CDS_HOST/认证/reposBase 全套前置条件 |
| feat | cds | 新增 cdscli import 命令：将已有 compose 文件直接提交 CDS，不重新扫描（issue #538/#539） |
| fix | cds | 修复 approveUrl 双 scheme bug（CDS_HOST 已含 https:// 时再拼接导致 https://https://...） |
| fix | cds | verify 对 CDS_*_PORT/_HOST/_URL 等运行时变量降级为 INFO，不再误报 ERROR（issue #538） |
| feat | cds | verify 支持直接传入文件路径（如 cdscli verify cds-comose.yml），不再要求标准文件名 |
| feat | cds | verify PyYAML 缺失时自动尝试安装，失败时给出平台特定手动命令 |
| feat | cds | scan 支持 Java/Maven/Spring Boot 多模块项目识别，生成 spring-boot:run 命令 |
| feat | cds | scan 自动读取 vite.config.ts/js 中的 server.port，不再把所有 Vite 服务硬编码为 3000 |
| feat | cds | scan 生成 YAML 自动填充 x-cds-project.repo（从 git remote get-url origin 读取） |
| fix | cds | project list/show 默认脱敏（customEnv/agentKeys 等），加 --include-sensitive 显示全部 |
| fix | cds | 删除 _emit_scan_result 中重复的 apply_to_cds 死代码块 |
