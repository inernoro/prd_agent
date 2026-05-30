| feat | prd-api | project-route-agent：LLM Extract 阶段只读方案 markdown 头部 2000 字（包含「涉及应用 / 业务模块」元信息），不再读全文 |
| feat | prd-api | LLM Extract 提示词重写为两步显式：① apps/modules → ② 按 modules 查公共说明里的仓库；强制只接受 https URL（容器内无 SSH key） |
| refactor | prd-api | ProjectRouteResolution 数据模型重构为「按仓库分组」：RepoUrl + ProjectPaths[] + MatchedAppsOrModules[]；新增 CloneFailed / NoRoutemap 两个状态 |
| feat | prd-api | Resolve 阶段：baseline 先按所有仓库占位（含 clone 失败/无 routemap），LLM 只填克隆成功的子集；clone 失败状态保留不被 LLM 覆盖 |
| fix | prd-api | GitRepoCacheService：clone 加 1 次重试、URL 自动补 .git 后缀、fetch+reset 兜底优先于 reclone、错误信息完整 trail 透传 |
| refactor | prd-admin | ProjectRouteResolution 类型同步重构；第三栏 UI 改为「仓库 × 项目路径」分组展示，匹配的 modules 以 pill 形式直接挂仓库下 |
| feat | prd-admin | ResolutionBadge 新增 CloneFailed / NoRoutemap 状态色 |
