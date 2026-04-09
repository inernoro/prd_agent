| feat | prd-api | PR审查棱镜新增 submissions 全流程 API（创建/列表/详情/刷新/删除）并接入 GitHub PR + L1 Gate + 决策卡解析 |
| feat | prd-api | 新增 pr_review_prism_submissions 集合模型与索引定义，支持同用户同仓库 PR 去重 |
| fix | prd-api | 为 PR 审查棱镜补充单元测试覆盖：PR URL 解析与决策卡字段解析（阻断项/提示项/关注问题） |
| fix | prd-api | 新增 PR审查棱镜 API 集成测试：鉴权、非法参数、提交复用、列表/详情、刷新、删除与删除后 404 |
| feat | prd-admin | PR审查棱镜页面从占位升级为可用界面：提交 PR 链接、列表检索、详情可视化、刷新与删除 |
| feat | prd-admin | PR审查棱镜页面增强交互：状态筛选、分页控制、更新时间展示与详情时间信息补全 |
| feat | prd-admin | PR审查棱镜新增“批量刷新当前筛选结果”与刷新进度反馈，便于批量回看多条提交 |
| feat | prd-admin | 新增 prReviewPrism 前端 API 路由与 real service，并导出统一 services 接口 |
| feat | prd-api | PR审查棱镜新增批量刷新接口 submissions/batch-refresh，单次支持最多100条并返回逐条失败原因 |
| feat | prd-admin | PR审查棱镜批量刷新切换为后端批量接口，接口不可用时自动降级逐条刷新并维持进度反馈 |
| fix | prd-api | PR审查棱镜集成测试补充批量刷新流程覆盖与空 ids 参数 400 校验 |
| feat | prd-api | PR审查棱镜 submissions 列表新增 gateStatus 服务端筛选，支持 all/pending/completed/missing/error |
| feat | prd-admin | PR审查棱镜状态筛选切换为服务端查询，分页/批量刷新与筛选条件一致 |
| fix | prd-api | PR审查棱镜集成测试新增非法 gateStatus 参数 400 校验 |
| feat | prd-api | PR审查棱镜列表接口新增 gateStatusCounts 全局计数返回，支持筛选标签展示真实总量 |
| feat | prd-admin | PR审查棱镜筛选标签计数改为服务端 gateStatusCounts，避免仅当前页统计偏差 |
| fix | prd-api | PR审查棱镜集成测试补充列表响应 gateStatusCounts 结构断言 |
| fix | prd-api | PR审查棱镜集成测试新增 q + gateStatus + gateStatusCounts 一致性校验，覆盖筛选与计数联动行为 |
| fix | prd-api | PR审查棱镜集成测试新增 batch-refresh 部分失败一致性校验（successCount/failureCount/failures/submissions） |
| fix | prd-api | PR审查棱镜集成测试新增 batch-refresh 上限 100 与重复 id 去重统计一致性校验 |
| fix | prd-api | 修复 PR URL 解析失败时 out 参数泄漏，确保非法编号（如 pull/0）返回 false 且 owner/repo/prNumber 保持空值 |
