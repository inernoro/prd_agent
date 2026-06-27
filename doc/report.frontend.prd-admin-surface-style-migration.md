# prd-admin 样式统一统计报表

生成日期：2026-04-29

## 结论

- ✅ 已建立统一样式基础设施：Surface System、样式分层、迁移技能、扫描脚本。
- ✅ 已完成我们负责的多轮高收益迁移：`StatsPage`、`ai-toolbox` 首轮 + 第二轮 + 首屏可见第三轮 + 公共 Shell/卡片统一 + 统计页式低噪声卡片再校准 + 卡片标题层补漏、公共 `TabBar` 导航统一、`marketplace` 背景/顶部导航清理 + 接入 AI 弹窗交互层级补漏、`/my-assets` 页面边界补漏、`defect-agent` 首轮 + 第二轮、`/mds` 模型组件、`workflow-agent` 首轮 + 编辑页第二轮 + 稳定面板小补漏、`ai-chat` 稳定壳层、`document-store`、`weekly-poster` 编辑器、`literary-agent` 配置管理、`SkillAgentPage` 两轮、`components/ui` 共享组件首轮、`lab-llm` 首轮、`settings` 普通设置页首轮、`components/watermark` 普通壳层首轮、`emergence` 弹窗/popover 首轮、`/settings?tab=assets` 资源管理页可见样板。
- ✅ 本轮新增统一规则：页面根不再二次缩进；页面级页签统一走公共 `TabBar`；顶部横条统一走 `surface-nav-bar`；右侧概览/详情使用独立 `.surface` 面板。
- ✅ `report-agent` 已按要求绕开，不纳入本轮改造。
- ⚠️ 当前剩余扫描分数仍高，但其中相当一部分是画布、品牌页、海报/图片编辑器、状态色和数据色，不应该机械清零。

## 统计口径

- 扫描命令：`pnpm --prefix prd-admin run style:debt:owned -- --top 80`
- 排除目录：`prd-admin/src/pages/report-agent`
- 扫描文件数：`632`
- 初始 owned debt：`45594`
- 当前 owned debt：`37730`
- 总下降：`7864`
- 本轮新增下降：`38832 -> 37747`
- `ai-toolbox` 首屏补强 + 公共 Shell/卡片统一：`37805 -> 37747`
- `ai-toolbox` 按统计页对齐 + Apple 式轻材质校准：`37747 -> 37805`（有意把卡片从整卡毛玻璃改为封面优先、底部轻材质信息层，增加项来自 shared styles 的局部透明色和小范围 blur，`ai-toolbox` 当前模块分为 `1345`）
- 公共导航 + `ai-toolbox` 统计页式低噪声卡片：`37805 -> 37792`
- `marketplace` 背景/顶部导航清理：`37792 -> 37745`
- `/my-assets` 页面边界补漏：`37745 -> 37727`
- `/ai-toolbox` 头部结构补漏：`37727 -> 37736`（共享 CSS active 高光小幅增加，换来头部层级统一）
- `/ai-toolbox` 卡片标题层补漏：`37736 -> 37741`（共享 CSS hover/focus 过渡小幅增加，换来标题不再整卡覆盖）
- `/marketplace` 顶部和筛选二次收敛：`37741 -> 37744`（共享市场导航类小幅增加，换来紧凑工具条和统一筛选 pill）
- `/marketplace` 接入 AI 新建页重构：`37744 -> 37726`（Start 页从大面积营销卡片改成紧凑向导表单，移除强制 88vh 空白）
- `/marketplace` 接入 AI 交互层级补漏：`37726 -> 37730`（小幅增加共享 CSS 层级样式，换来主路径、备选路径、只读能力、流程提示的明确分层）
- `components/ui`：`1302 -> 981`
- `lab-llm`：`1002 -> 486`
- `LlmLabTab.tsx`：`883 -> 367`
- `SkillAgentPage.tsx`：`936 -> 617`（第二轮 `879 -> 617`）
- `settings`：`1093 -> 435`
- `DailyTipsEditor.tsx`：`484 -> 194`
- `NavLayoutEditor.tsx`：`141 -> 45`
- `ThemeSkinEditor.tsx`：`153 -> 91`
- `marketplace`：`1024 -> 207`
- `MarketplacePage.tsx`：剩余 `62`
- `SkillUploadDialog.tsx`：剩余 `95`
- `MarketplaceCard.tsx`：剩余 `14`
- `components/watermark`：`518 -> 276`
- `WatermarkSettingsPanel.tsx`：`477 -> 258`
- `emergence`：`1163 -> 959`
- `EmergenceCreateDialog.tsx`：`202 -> 99`
- `EmergenceInspireDialog.tsx`：`87 -> 34`
- `workflow-agent`：`2447 -> 1908`（编辑页第二轮 + 稳定面板小补漏）
- `WorkflowEditorPage.tsx`：`629 -> 303`
- `ArtifactPreviewModal.tsx` / `HttpConfigPanel.tsx`：小补漏后退出 top 80
- `defect-agent`：`1823 -> 1278`
- `DefectDetailPanel.tsx`：`420 -> 229`
- `DefectCard.tsx`：`236 -> 188`
- `DefectSubmitPanel.tsx` / `SharesListPanel.tsx`：第二轮后退出 top 80
- `ai-toolbox`：`1860 -> 1345`
- `QuickCreateWizard.tsx`：`541 -> 309`
- `ToolEditor.tsx`：`460 -> 275`
- `ToolCard.tsx`：`303 -> 215`
- `ToolDetail.tsx`：当前 `259`
- `AssetsManagePage.tsx`：`363 -> 186`

| 指标 | 当前值 |
| --- | ---: |
| 总债务分 | 37730 |
| Inline style | 5765 |
| Hard-coded color | 8259 |
| Arbitrary Tailwind | 4893 |
| Heavy visual effect | 1195 |
| Surface/design 使用信号 | 3020 |

## 公用基础层

| 类型 | 内容 | 状态 |
| --- | --- | --- |
| 样式分层 | `base.css`、`surface.css`、`motion.css`、`legacy.css` | ✅ 已完成 |
| Surface 类 | `.surface`、`.surface-raised`、`.surface-inset`、`.surface-row`、`.surface-popover` | ✅ 已完成 |
| Token 文本 | `.text-token-primary`、`.text-token-secondary`、`.text-token-muted`、`.text-token-error` 等 | ✅ 已完成 |
| Token 背景/边框 | `.bg-token-nested`、`.bg-token-card`、`.border-token-subtle`、`.border-token-nested` | ✅ 已完成 |
| 表单统一 | `.prd-field` | ✅ 已落地到多处输入框 |
| 组件出口 | `src/components/design/Surface.tsx`、`design/index.ts` | ✅ 已完成 |
| 百宝箱公共 Shell | `pages/ai-toolbox/components/ToolboxShell.tsx` | ✅ 已完成，页面级页签已改回公共 `TabBar` |
| 公共顶部导航 | `components/design/TabBar.tsx` + `.surface-nav-*` | ✅ 已按统计页横条基准统一 |
| 页面边界规则 | AppShell 管一级留白，业务页不再重复 `mx-auto/max-w/px/p` 外框 | ✅ 已用于 `/workflow-agent`、`/marketplace`、`/my-assets` |
| 自动扫描 | `scripts/style-debt-report.mjs`、`style:debt:*` npm scripts | ✅ 已完成 |
| 迁移技能 | `.agents/skills/surface-style-migration/SKILL.md` | ✅ 已完成 |

## 成熟组件复用

| 组件/库 | 当前用途 | 建议 |
| --- | --- | --- |
| `GlassCard` | 高级玻璃卡片、复杂页面容器 | ✅ 保留，逐步减少重复 inline 样式 |
| `Surface` | 普通卡片、面板、列表壳层 | ✅ 新增场景优先使用 |
| `Button` | 配置弹窗、技能页、工具按钮 | ✅ 新增按钮优先使用 |
| `Dialog` | 编辑弹窗、配置弹窗 | ✅ 保留，避免重复写 modal 样式 |
| `ConfigManagementDialogBase` | 文学 agent 配置管理框架 | ✅ 已复用，不拆散 |
| `WatermarkSettingsPanel` | 水印配置成熟面板 | ✅ 保留 |
| `DocBrowser` | 文档库浏览、右键菜单、标签 | ✅ 作为共享业务组件继续收敛 |
| `Model*` 组件 | `/mds` 和模型管理基础能力 | ✅ 已首轮统一 |
| `ReactFlow` | workflow 画布 | ✅ 保留几何/交互样式 |
| `Radix DropdownMenu` | LLM Lab 等复杂菜单 | ✅ 保留，外层逐步接 Surface |
| `MarkdownContent` / `ReactMarkdown` | Markdown 预览和正文 | ✅ 保留内容渲染样式边界 |

## 个性化视觉例外

这些地方不应该为了降低扫描分数强行改成通用 Surface：

| 区域 | 原因 | 处理方式 |
| --- | --- | --- |
| `pages/home` | 品牌/营销首页，视觉表达、动效、渐变是产品门面 | ✅ 记录例外，后续只统一导航/普通按钮 |
| `pages/library` | “智识殿堂”公共品牌体验页，claymorphism 硬边框、奶油底色、浅色阅读器是产品视觉 | ✅ 记录例外，后续只统一后台弹窗/跨域复用组件 |
| `weekly-poster/PosterDesignerPage.tsx` | 海报设计器，颜色和布局是作品内容的一部分 | ✅ 只迁移工具栏/侧栏，不改画布和海报预览 |
| `literary-agent/ArticleIllustrationEditorPage.tsx` | 图片/插画编辑器，存在大量预览、编辑态、视觉语义 | ✅ 只迁移配置、列表、普通弹窗 |
| `ai-chat/AdvancedVisualAgentTab.tsx` | 画布、缩放、拖拽、图片渲染、工具浮层复杂 | ✅ 已迁移稳定壳层，保留画布运行时样式 |
| `workflow-agent/WorkflowCanvas.tsx` | ReactFlow 坐标、节点状态、连线、transform | ✅ 已迁移壳层，保留几何样式 |
| 图表/状态/数据色 | 成功、失败、警告、运行中、平台色、分类色有业务含义 | ✅ 保留或逐步 token 化，不机械替换 |
| 图片透明棋盘格 | 用于展示透明背景 | ✅ 保留 |
| CTA 品牌渐变 | 新建、发布、生成等主行动作需要强识别 | ✅ 可保留，但避免扩散到普通按钮 |

## 已完成模块

| 模块 | 状态 | 本轮策略 |
| --- | --- | --- |
| 基础设施 | ✅ 完成 | 建立 Surface、token、扫描脚本和迁移技能 |
| `StatsPage` | ✅ 首轮完成 | 普通卡片和文本统一 |
| `ai-toolbox` | ✅ 首轮 + 第二轮 + 首屏可见第三轮 + 公共 Shell/卡片统一 + 统计页式低噪声卡片再校准 + 头部补漏 + 卡片标题层补漏完成 | 工具详情、创建向导、编辑器壳层、首屏工具台、基础能力页、工具卡信息面板、可见配置面板统一；页面级页签回到公共 `TabBar`，筛选/搜索拆成独立横条；卡片改为 16:10 紧凑低噪声样式，默认标题层收回到底部透明信息区 |
| `defect-agent` | ✅ 首轮 + 详情弹窗第一轮 + 第二轮完成 | 过滤器、列表、项目弹窗、详情弹窗、卡片、提交、分享、统计普通壳层统一 |
| `/mds` 模型组件 | ✅ 首轮完成 | 模型列表、KPI、类型选择器统一 |
| `workflow-agent` | ✅ 首轮 + 编辑页第二轮 + 稳定面板小补漏完成 | 列表、模板、编辑器、画布稳定壳层、产物预览、HTTP 配置面板统一 |
| `ai-chat` | ✅ 首轮完成 | 工具栏、聊天侧栏、输入区、弹层统一 |
| `document-store` | ✅ 首轮完成 | 页面弹窗、抽屉、DocBrowser 壳层统一 |
| `weekly-poster` | ✅ 首轮完成 | 高级编辑器普通壳层和字段统一 |
| `literary-agent` | ✅ 首轮完成 | 配置管理弹窗普通壳层统一 |
| `SkillAgentPage.tsx` | ✅ 两轮完成 | 顶部导航、阶段栏、输入区、我的技能、草稿、广场、详情/测试普通壳层统一 |
| `components/ui` | ✅ 首轮完成 | Tabs、ConfirmTip、ContextMenu、移动弹层、头像弹窗、用户资料弹层、全局缺陷弹窗普通壳层 |
| `lab-llm` | ✅ 首轮完成 | 实验配置、模型分组、提示词区、结果普通壳层、实验弹窗统一 |
| `settings` | ✅ 首轮完成 | 日常小技巧、导航布局、我的空间、收藏技能、账户、更新加速、皮肤设置普通壳层统一 |
| `/settings?tab=assets` | ✅ 可见样板完成 | 资源管理页面 tab、资源分组、上传块、资源矩阵、表格壳层统一 |
| `/my-assets` | ✅ 页面边界补漏完成 | 顶部工具条改用公共 `surface-nav-bar`，内容区去掉 `p-4` 二次缩进，右侧概览/详情改为独立 `.surface` 面板 |
| `marketplace` | ✅ 首轮 + 背景/顶部导航再校准 + 顶部/筛选二次收敛 + 接入弹窗新建页重构 + 交互层级补漏完成 | 上传弹窗、OpenAPI 弹窗、列表页导航/筛选、通用卡片普通壳层统一；去掉点阵/大光斑/装饰水印背景，顶部工具条和分类筛选条压回公共 46px/28px 导航尺度，接入 AI 新建页改为紧凑向导表单；弹窗中只保留左侧主/备两条可点击路径，右侧能力为只读清单，底部为轻量流程提示 |
| `components/watermark` | ✅ 首轮完成 | 说明网格、颜色选择器、配置列表、编辑表单普通壳层统一 |
| `emergence` | ✅ 弹窗/popover 首轮完成 | 新建弹窗、灵感弹窗、涌现选项弹层普通壳层统一 |

## 当前重灾区

| 排名 | 模块 | 分数 | 判断 |
| ---: | --- | ---: | --- |
| 1 | `pages/workflow-agent` | 1908 | 已完成稳定面板小补漏，剩余多为画布/节点/状态/模板/运行态例外 |
| 2 | `pages/home` | 1530 | 主要是品牌视觉例外 |
| 3 | `pages/ai-toolbox` | 1345 | 公共 Shell、基础能力页、首屏卡片和统计页式低噪声卡片校准已完成，剩余主要是 `QuickCreateWizard`、`ToolEditor`、`ToolDetail` 内部子面板 |
| 4 | `pages/ai-chat` | 1305 | 大量是画布和编辑器运行时样式 |
| 5 | `pages/defect-agent` | 1278 | 第二轮已完成，剩余主要是状态/严重程度色、附件预览和列表行边缘 |
| 6 | `pages/literary-agent` | 1256 | 主编辑器个性化重，配置区已先迁移 |
| 7 | `pages/weekly-poster` | 1255 | 设计器个性化重，高级编辑器已先迁移 |
| 8 | `pages/document-store` | 1203 | 已首轮迁移，剩余多为 DocBrowser 细节 |
| 9 | `pages/library` | 1084 | 已评估为公共品牌体验页，先作为个性化例外 |
| 10 | `components/ui` | 981 | 已首轮治理，剩余主要为状态色、图片/日志语义色、加载动画 |
| 11 | `pages/emergence` | 959 | 已完成弹窗/popover 首轮，剩余主要是首页品牌视觉、节点视觉指纹、流式状态条和画布动画 |
| 17 | `pages/SkillAgentPage.tsx` | 617 | 已从重灾区降级，剩余主要是分类/阶段色、发布/复制/下载状态色、局部运行态 |
| 29 | `pages/lab-llm` | 486 | 已从重灾区降级，剩余主要是图片预览/运行时布局例外 |
| 34 | `pages/settings` | 435 | 已从重灾区降级，剩余主要是皮肤预览动态样式和少量拖拽/状态色 |
| 55 | `pages/marketplace` | 207 | 已从重灾区降级，背景、顶部导航、分类筛选和接入 AI 弹窗交互层级已清理，剩余主要是上传预览、状态色和少量动态筛选态 |
| 46 | `components/watermark` | 276 | 已从重灾区降级，剩余主要是水印预览画布、拖拽定位、动态颜色和 range 渐变 |
| 补充 | `pages/AssetsManagePage.tsx` | 186 | 当前页已做可见统一，剩余主要是资源预览、动态尺寸和状态 badge |

## 下一步建议

1. ✅ `marketplace` 和 `components/watermark` 已降级，后续只做小补漏，不再作为重灾区优先项。
2. ✅ `ai-toolbox`、`defect-agent`、`workflow-agent` 本轮高收益第二轮/小补漏已完成；`ai-toolbox` 已补上公共 Shell、基础能力页和卡片统一，后续只做明确页面问题驱动的小补漏。
3. ✅ `library` 不做后台 Surface 化，只记录公共品牌体验页例外。
4. ✅ `lab-llm` / `SkillAgentPage` 暂时只做边缘补漏：保留生图预览、动态布局、分类色和运行状态色。
5. ✅ 对 `workflow-agent` 只做稳定子壳，不动 ReactFlow 几何和节点运行态。
6. ✅ 对 `home`、海报设计器、插画编辑器只做边缘统一，不把品牌视觉改成后台通用卡片。

## 不该做

- 🚫 不追求扫描分数清零。
- 🚫 不替换画布坐标、拖拽、缩放、transform。
- 🚫 不替换图表、状态、分类、平台、作品内容颜色。
- 🚫 不一次性重写大型编辑器。
- 🚫 不碰 `report-agent`，等待对应负责人迁移。

## 立竿见影做法

- ✅ 页面根容器统一：`bg-token-nested`。
- ✅ 面板/弹窗/抽屉统一：`.surface`、`.surface-inset`、`.surface-popover`。
- ✅ 列表行统一：`.surface-row`。
- ✅ 输入框统一：`.prd-field`。
- ✅ 文本色统一：`.text-token-*`。
- ✅ 边框统一：`.border-token-*`。
- ✅ JS hover 改 CSS hover。

## 验证状态

- ✅ `pnpm --prefix prd-admin tsc` 通过。
- ✅ `pnpm --prefix prd-admin run style:debt:owned -- --top 20` 通过，当前 `37730`；`/marketplace` 接入 AI 交互层级补漏后小幅增加 `4` 分，换来明确的主路径/备选路径/只读说明分层。
- ✅ `pnpm --prefix prd-admin build` 通过。
- ✅ `git diff --check` 通过。
- ✅ 当前本地预览可访问：`http://127.0.0.1:8010/`
- ✅ 已恢复本地预览环境：前端 `127.0.0.1:8010`，后端 `localhost:5001`，MongoDB `127.0.0.1:27017`，Redis `127.0.0.1:6379`。
- ✅ 关键截图已校对：`/executive`、`/ai-toolbox`、`/my-assets`、`/workflow-agent`、`/marketplace`、`/mds`、`/settings?tab=assets`、`/document-store`、`/assets`。
- ⚠️ 没有宣称“每个页面、每个滚动深度、每个弹窗状态”都校对完成；当前完成的是本轮改动影响面和用户指出页面的截图校对。
- ⚠️ 校对结论：`/executive` 是当前统一标尺；`/ai-toolbox` 已拆回公共 `TabBar` + 独立筛选横条，卡片标题层已收回到底部透明信息区；`/marketplace` 顶部和筛选已改为紧凑导航尺度，接入 AI 新建页已改为紧凑向导表单；`/workflow-agent`、`/marketplace`、`/my-assets` 的左边界已对齐。
- ✅ `/ai-toolbox` HTTP 200，浏览器预览正常渲染，公共 Shell、基础能力页和卡片底部透明信息面板已更新。
- ✅ `/marketplace` DOM 预览正常渲染，背景、顶部导航和分类筛选已按统计页基准收敛；`接入 AI` 弹窗截图已校对，新建页无中段大空白，四个“像卡片”的区域已改成主入口、次入口、只读清单和轻量路径条。
- ✅ `/defect-agent` 浏览器预览正常渲染，无 500。
- ✅ `/workflow-agent` 浏览器预览正常渲染，无 500。
- ✅ `/settings?tab=assets` HTTP 200，浏览器预览正常渲染。
- ✅ 路由可访问：`/workflow-agent`、`/defect-agent`、`/emergence`、`/mds` 均返回 HTTP 200。
- ✅ 历史已验证路由：`/settings`、`/skill-agent`、`/marketplace?type=skill` 返回 HTTP 200。
- ⚠️ 构建仍有既有 Vite chunk/import 警告，不是本次样式迁移引入的阻塞问题。
- ⚠️ 浏览器控制台还能看到历史路由留下的 ReactFlow/ECharts/DOM nesting 警告，当前 `/ai-toolbox` 没有 500、空白页或明显渲染中断。
