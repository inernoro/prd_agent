| feat | cds | 分支子域名别名（Subdomain Aliases）：每个分支除默认 `<slug>.<rootDomain>` 外可额外挂 N 个稳定别名 |
| feat | cds | 新增 `BranchEntry.subdomainAliases?: string[]` 字段 + state 层 get/set/findBranchByAlias/findAliasCollisions |
| feat | cds | ProxyService.extractPreviewBranch 先查别名，命中则路由到对应分支；未命中才退回 slug 兜底。别名总是胜过同名 slug |
| feat | cds | 新增 REST 端点：GET/PUT `/api/branches/:id/subdomain-aliases`，带 DNS 合法性校验 + 保留字拦截（www/admin/switch/preview/cds/master/dashboard）+ 跨分支冲突检测（409） |
| feat | cds | 容器配置 modal 新增独立的 `🌐 子域名` 标签页（分支级，不属于任何 profile）：chip 列表 + 单行添加 + 即点即删 + 每个别名的预览 URL 直达 |
| feat | cds | 别名保存立即生效，无需重新部署（代理层级改动，非容器启动时合并） |
| test | cds | 新增 9 个 state 单元测试（set/get/findBranchByAlias/findAliasCollisions 的 slug 冲突、alias 冲突、case-insensitive、自引用豁免） |
| test | cds | 新增 6 个 proxy 单元测试（extractPreviewBranch 别名命中、大小写不敏感、别名胜过同名 slug、非 rootDomain 返回 null、端口号剥离） |
