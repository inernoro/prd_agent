| feat | prd-api | 新增 MarkdownSectionExtractor：确定性解析方案 md 里「应用」/「业务模块」章节原话（命中关键词：涉及应用/相关应用/应用范围/应用 + 业务模块/涉及模块/相关模块/功能模块/模块），不让 AI 拆解原文 |
| feat | prd-api | 新增 ThirdPartyRepoExtractor：从命中的 routemap *.md 文件内容里用正则扫出所有第三方 git URL（https / git@ / ssh:// 三种），去重后写入 Resolution.LinkedThirdPartyRepos |
| feat | prd-api | ProjectRouteExtractedRepo 新增 SourceContext 字段：公共说明里命中此仓库的完整原文段落（不截断） |
| feat | prd-api | ProjectRouteResolution 新增 LinkedThirdPartyRepos + RoutemapFiles（含完整文件内容）字段，前端「查看明细」用 |
| refactor | prd-api | Controller.ExtractAppsAndReposAsync 流程改造：确定性章节命中时直接用原话覆盖 LLM 输出，LLM 仅负责仓库匹配 + sourceContext；找不到章节才回退 LLM 兜底 |
| feat | prd-admin | 第二栏「② 当前方案关联仓库地址」（改名）+ RepoCard 可折叠展开查看详情：完整 reasoning / sourceContext / routemap 子目录全部列表（不省略） |
| feat | prd-admin | 第三栏「③ 仓库 × 关联项目路径」（改名）+ ResolutionCard 可折叠展开查看 routemap *.md 文件全文 + 第三方仓库 URL 列表（可点击跳转） |
| feat | prd-admin | 最近方案：显示模块/仓库/路径统计；当前选中卡显示「重新分析」按钮；分析视图顶部显示「正在查看历史记录」banner（含提交时间 + 完成时间） |
