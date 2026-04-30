| feat | cds | 将 CDS 系统设置页迁移到 React：`/cds-settings` 接入 `MIGRATED_REACT_ROUTES`，新增 Radix Tabs 包装和 7 个系统设置 tab，所有新页 API 调用走 `apiRequest()`；删除 legacy `cds-settings.html/js`，并把旧入口统一改到干净路径 |
| feat | cds | 在 React `/cds-settings#github` 补齐 GitHub Device Flow：展示配置/连接状态、设备码登录轮询、复制代码、打开 GitHub、断开连接确认，并保留 GitHub App webhook/check-run 配置面板 |
| fix | cds | 修复本地初始化与预览启动：`exec_cds.sh init` 在 `sh` 调用时自动切回 bash，并修正 MongoDB 启动提示中的变量边界；后台启动端口检测增加 macOS `lsof` fallback，避免没有 `ss` 时误判 CDS 未启动 |
| feat | cds | `/cds-settings#maintenance` 补齐 React 自更新控制台：展示当前源码分支/commit、目标分支选择、自更新预检、更新重启、强制同步确认和可复制 SSE 日志 |
| feat | cds | `/cds-settings#global-vars` 改为可编辑环境变量表：支持新增、编辑、删除、搜索、密钥遮蔽/显示/复制，并保留全局变量一键整理到项目的 dry-run 预览 |
| feat | cds | `/cds-settings#storage` 展示 mongo-split 目标状态、Mongo 健康、`.cds.env` 注入诊断，以及 `cds_projects / cds_branches / cds_global_state` 集合计数 |
| feat | cds | `/cds-settings#cluster` 从只读节点列表升级为集群控制台：展示主机健康、调度策略、执行器详情，支持签发连接码、粘贴加入主节点、退出集群、排空/移除节点 |
| feat | cds | `/cds-settings#auth` 补统一认证状态与退出入口；basic/GitHub 模式可直接退出登录，disabled 模式明确显示本地开发状态 |
| fix | cds | 补齐 host-stats、activity/state stream、cluster/executor、AI pairing 和 Bridge API 的中文 label，避免启动日志和 Activity Monitor 出现无意义空标签 |
| fix | cds | 修复 React 设置页 hash 深链：同一页面内切换 `#storage/#maintenance/#global-vars` 时 tab 内容会跟随 URL，不再停留在旧 tab |
| fix | cds | CDS 真实运行时默认存储改为 `mongo-split`；未配置 `CDS_MONGO_URI` 会要求先运行 `./exec_cds.sh init`，只在测试或显式兼容模式继续使用 JSON |
