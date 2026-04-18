| fix | cds | `/quickstart` 优先读取项目仓库根目录下的 `cds-compose.yaml`/`cds-compose.yml`，用其声明的 buildProfiles + envVars + infraServices 代替硬编码模板，修复 fork 出的项目因缺少 MongoDB/Redis/JWT 环境变量导致的 Redis 连接崩溃 |
| fix | cds | `/quickstart` 合并 cds-compose 的 envVars 时跳过已存在的 customEnv key，不覆盖 legacy 手工配置；infraServices 按 projectId 作用域去重，避免两个项目同名 `mongo` 互相冲突 |
| fix | cds | `/quickstart` 构建配置 id 后缀从 `projectId` 前 8 位十六进制改为项目 slug（如 `api-prd-agent-2`），topology 视图更易辨识；legacy default 项目继续使用无后缀 id 保持向后兼容 |
