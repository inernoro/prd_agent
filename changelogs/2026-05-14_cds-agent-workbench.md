| feat | prd-api | CDS Agent 增加系统级模型运行配置、长效授权会话启动、真实 Claude SDK sidecar 事件接入、AI 百宝箱和工作流舱调用入口 |
| feat | prd-admin | 新增 CDS Agent 独立用户页面，并在基础设施服务页增加模型运行配置和 Agent 操作台 |
| feat | cds | CDS 配对 long token 调整为系统级长期授权，并在 agent session 中接收 runtime profile、baseUrl、model 和凭据状态 |
| feat | cds | CDS compose 增加 claude-sidecar runtime 服务，并让 MAP API 在 CDS 环境默认路由到 sidecar 容器 |
| fix | prd-api | 修复 CDS 授权回跳地址，回到设置页基础设施服务入口完成连接建立 |
| fix | prd-api | 修复 CDS Agent 模型密钥解密失败时启动会话返回 500 的问题，改为提示重新保存配置 |
| fix | prd-api | 修复历史 CDS 授权密文失效后仍显示已连接、重复授权被旧连接阻塞的问题 |
| fix | prd-api | CDS Agent 发送消息遇到模型上游失败时写入会话失败事件，不再只返回 502 toast |
| fix | prd-api | CDS Agent 日志接口不可用时回退展示本地持久化事件，并向 sidecar 暴露已注册安全工具 |
| feat | prd-api | CDS Agent 新增仓库工具，支持远程 sidecar 读取文件、搜索、写入、运行命令并限制工作目录逃逸 |
| feat | prd-api | CDS Agent sidecar 工具调用改为先等待 MAP 审批再执行，危险仓库工具不得绕过用户确认 |
| feat | prd-api | CDS Agent runtime profile 增加模型连通性测试接口，使用已保存密钥验证 baseUrl/model 是否真的可用 |
| feat | prd-admin | 基础设施服务页展示 CDS Agent 内置仓库工具，并把默认任务调整为 prd_agent 巡检场景 |
| feat | prd-admin | CDS Agent 对话页增加工具调用和命令结果专属渲染，展示 exitCode、stdout、stderr |
| feat | prd-admin | CDS Agent 对话页增加“测试模型”按钮，保存配置后可直接看到上游 HTTP 状态、耗时和错误详情 |
| fix | cds | CDS Agent claude-sdk 会话不再显示 fake worker，也不再向真实 runtime 混入 fake 文本 |
| fix | cds | 为 MAP API 增加 DataProtection 持久化 volume，并修正 CDS 内部 sidecar 与 callback 服务地址 |
| fix | cds | 将 MAP API 的 NuGet 缓存挂载改为项目相对目录，避开只读宿主机缓存路径导致的部署失败，并保留原 DataProtection key volume |
| fix | cds | 将 CDS Agent workspace 挂载为可写 `/repo`，使远程仓库工具具备最小代码巡检和改动能力 |
| docs | doc | 补齐 CDS Agent 用户指南、管理员指南、API 契约、运行手册与完全可用路线计划 |
