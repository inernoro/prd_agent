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
| feat | prd-api | PR审查棱镜门禁新增 bootstrap 顶设占位防呆阻断，避免新仓库在未初始化真实依据时误通过 |
| feat | scripts | 新增 init-pr-prism-basis 一键初始化脚本，自动生成最薄顶设文档与 pr-architect 绑定配置 |
| feat | doc | 新增 PR审查棱镜新仓库接入指南，提供 10 分钟初始化步骤与验收命令 |
| fix | prd-api | PR审查相关 workflow 触发分支扩展至 main/develop/master/trunk，避免默认分支差异导致门禁不触发 |
| feat | prd-api | PR审查棱镜新增 setup-status 配置检查接口，返回 GitHub Token 与顶层设计基线就绪状态及可执行指引 |
| feat | prd-admin | PR审查棱镜页面新增“初始化与配置检查”面板，显式展示 Token/顶设状态并提供初始化命令提示 |
| fix | prd-api | PR审查棱镜集成测试新增 setup-status 鉴权与响应结构断言，防止配置可见性能力回归 |
| feat | scripts | init-pr-prism-basis 支持零参数自动识别仓库与 owner，显著降低新仓库初始化成本 |
| feat | prd-api | PR审查棱镜 setup-status 返回 skillTemplatePath 与零参数初始化命令，支持新仓库技能模板化接入 |
| feat | doc | 新增 PR 审查棱镜 skill 模板文档，明确“顶层设计上传 → design-sources 激活 → gate 校验”最佳路径 |
| feat | prd-api | PR审查棱镜新增 bootstrap-skill-package 导出接口，返回仓库专属 Skill 包 zip（含脚本与模板） |
| feat | prd-api | PR审查棱镜 setup-status 支持 repo 参数按仓库校验绑定状态，并返回 targetRepo/match 信息 |
| fix | prd-api | PR审查棱镜集成测试新增 setup-status 仓库参数与 bootstrap-skill-package 鉴权/入参/zip 响应覆盖 |
| feat | prd-admin | PR审查棱镜页面新增“我的仓库”切换、仓库级 setup-status 检查与仓库专属 Skill 包导出入口 |
| feat | prd-admin | PR审查棱镜新增“最近仓库”可视化快捷区与“切换并恢复参数”按钮，降低多仓库切换学习成本 |
| feat | prd-api | PR审查棱镜 submissions 列表新增 repo 参数过滤与回显，支持 owner/repo 或 PR URL 格式 |
| fix | prd-api | PR审查棱镜集成测试新增 submissions repo 过滤场景，验证跨仓库结果隔离与回显字段 |
| feat | prd-admin | PR审查棱镜支持仓库工作区持久化：最近仓库快捷切换、按仓库过滤列表、按仓库记忆 owner/context/anchor 参数 |
| feat | prd-admin | 首页仅保留一个 PR审查棱镜主图入口，移除快捷条重复入口并补充专属主图插画 |
| feat | prd-admin | PR审查棱镜将“新仓库接入向导”改为从“我的仓库”点击新增后展开，并收敛为充分必要按钮（导出Skill包/重新检测/开始审查） |
| feat | prd-admin | PR审查棱镜新增仓库级接入状态卡（Token/顶设/可审查）与接入完成自动回流（入库、选中、收起向导） |
| feat | prd-api | PR审查棱镜新增 token-config 读写接口，支持页面内配置 GitHub Token（AppSettings 加密存储 + 脱敏回显） |
| feat | prd-api | PR审查棱镜 GitHub 拉取逻辑改为优先读取 AppSettings Token，缺省回退环境变量，兼容旧部署方式 |
| feat | prd-admin | PR审查棱镜接入向导 Step1 新增 Token 输入与保存，支持来源提示、脱敏状态、无权限提示与一键重新检测 |
| fix | prd-api | PR审查棱镜 setup-status guidance 升级为“页面配置优先 + 环境变量兜底”提示，降低小白配置门槛 |
| fix | prd-api | PR审查棱镜集成测试新增 token-config 鉴权与返回结构断言，防止可视化配置能力回归 |
