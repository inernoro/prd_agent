| refactor | prd-api | project-route-agent V2：移除 ProjectRouteSiteSpec.Repos 仓库登记表字段；分析阶段 AI 直接从公共说明 markdown 抽 git URL |
| feat | prd-api | ProjectRoutePlan 加 ExtractedRepos[]：本次分析 AI 选中要克隆的仓库列表（每条带 reasoning） |
| feat | prd-api | LLM Extract 阶段合并为一次调用：apps + modules + repos 同步输出 |
| refactor | prd-admin | 管理员视图删整个「仓库登记表」section，仅保留标题 + markdown 上传/编辑 |
| feat | prd-admin | 管理员视图新增「仓库登记方式」说明 + markdown 内嵌仓库 URL 示范代码块 |
| feat | prd-admin | 分析视图第二栏改为展示 AI 选中的仓库（含 AI 的 reasoning）+ 实时克隆状态合并显示 |
