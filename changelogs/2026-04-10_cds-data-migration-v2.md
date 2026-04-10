| feat | cds | 数据迁移支持跨 CDS 密钥一键直连：新增「CDS 密钥管理」面板，可复制本机访问密钥、注册远程 CDS，源/目标均可选择密钥，HTTPS 流式传输，无需 SSH 或复杂配置 |
| feat | cds | 数据迁移重构为流式管道（mongodump \| mongorestore），彻底去除临时文件，使用 `--archive --gzip` 单流传输，修复大库迁移 `use of closed network connection` 断连问题 |
| feat | cds | SSH 迁移改用命令模式而非端口转发：`ssh jump "mongodump --archive --gzip" \| mongorestore`，加入 ServerAliveInterval=30 保活，长时间 dump 不再断流 |
| feat | cds | SSH 隧道新增「测试隧道」按钮，直接验证 ssh 连通性与远端 mongodump 可用性，不再被迫等到「无法获取数据库列表」才发现问题 |
| feat | cds | SSH 隧道新增「docker 容器名」字段，支持 `ssh jump "docker exec <container> sh -c 'mongodump...'"` 模式，兼容远端 mongo 仅以容器形态存在的场景 |
| feat | cds | 数据迁移任务卡片新增「编辑」按钮，可修改名称、源/目标、集合选择（运行中禁用）；新增 PUT /api/data-migrations/:id |
| fix | cds | 修复「新建数据迁移」对话框输入框溢出问题：主机+端口改为严格 flex 约束（mc-input / mc-host / mc-port），port 固定 68px，其他字段 `min-width:0` 防止溢出 |
| feat | cds | 新增对等 CDS 端点：/my-key /peers CRUD /peers/:id/{test,list-databases,list-collections} /local-dump /local-restore /test-tunnel，均复用现有 X-AI-Access-Key 鉴权 |
| feat | cds | MongoConnectionConfig 新增 `type: 'cds'` 与 `cdsPeerId` 字段，CdsPeer 存储于 state.json（加载时自动迁移旧状态） |
