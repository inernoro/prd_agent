# prd-admin 样式统一迁移看板

更新时间：2026-04-29

## 一眼看进度

> 说明：下面的“已完成”均表示“第一轮稳定壳层迁移完成”，不是整个项目样式债务清零。画布、编辑器、品牌页、数据/状态色会按例外处理。

- ✅ 已完成：Surface 基础层、样式拆分、债务扫描脚本、迁移技能文档
- ✅ 已完成：`StatsPage`、`defect-agent` 第一轮统一，`ai-toolbox` 首轮 + 第二轮 + 首屏可见第三轮 + 公共 Shell/卡片统一
- ✅ 已完成：`/mds` 共享模型组件第一轮统一
- ✅ 已完成：`workflow-agent` 列表页、模板弹窗、演示页、编辑器稳定壳层第一轮统一
- ✅ 已完成：`workflow-agent/WorkflowCanvas.tsx` 稳定壳层第一轮统一
- ✅ 已完成：`workflow-agent/WorkflowCanvas.tsx` 剩余稳定子壳
- ✅ 已完成：`ai-chat` 稳定壳层第一轮统一
- ✅ 已完成：`document-store` 稳定壳层第一轮统一
- ✅ 已完成：`weekly-poster` 编辑器稳定壳层第一轮统一
- ✅ 已完成：`literary-agent` 配置管理弹窗第一轮统一
- ✅ 已完成：`SkillAgentPage.tsx` 顶部导航、阶段栏、输入区第一轮统一
- ✅ 已评估：`home` 是品牌/营销视觉页，先作为个性化例外记录，不强行迁移
- ✅ 已完成：`components/ui` 共享组件第一轮稳定壳层统一
- ✅ 已完成：`lab-llm` 稳定壳层第一轮统一
- ✅ 已完成：`SkillAgentPage.tsx` 剩余普通面板第二轮统一
- ✅ 已完成：`settings` 普通设置页第一轮统一
- ✅ 已评估：`library` 是“智识殿堂”公共品牌体验页，先作为个性化例外记录
- ✅ 已完成：`marketplace` 普通壳层第一轮统一
- ✅ 已完成：`components/watermark` 普通壳层第一轮统一
- ✅ 已完成：`emergence` 弹窗/popover 普通壳层第一轮统一
- ✅ 已完成：`workflow-agent` 编辑页稳定壳层第二轮统一
- ✅ 已完成：`defect-agent` 详情弹窗第一轮统一
- ✅ 已完成：`/settings?tab=assets` 资源管理页可见统一样板
- ✅ 已完成：`ai-toolbox` 第二轮可见统一
- ✅ 已完成：`ai-toolbox` 公共 Shell、页签工具条、基础能力页和工具卡片统一
- ✅ 已完成：按“统计页卡片/导航”为基准，统一公共 `TabBar` 和百宝箱低噪声工具卡
- ✅ 已完成：按同一基准清理 `marketplace` 页面背景和顶部导航
- ✅ 已完成：`/marketplace` 顶部工具条和分类筛选条二次收敛，压回公共 46px/28px 导航尺度
- ✅ 已完成：`/marketplace` 接入 AI 弹窗新建页二次收敛，借鉴 Key 创建/安装向导改成紧凑接入表单
- ✅ 已完成：`/marketplace` 接入 AI 弹窗交互层级补漏，主路径/备选路径/只读能力/流程提示分层
- ✅ 已完成：`/my-assets` 页面左边界、顶部工具条、内容区二次缩进补漏
- ✅ 已完成：`/ai-toolbox` 头部结构补漏，页面级页签改回公共 `TabBar`，筛选/搜索拆成独立横条
- ✅ 已完成：`/ai-toolbox` 工具卡标题层补漏，信息面板从整卡覆盖收回到底部透明层
- ✅ 已完成：`defect-agent` 卡片/提交/分享/统计第二轮统一
- ✅ 已完成：`workflow-agent` 产物预览和 HTTP 配置稳定面板小补漏
- ✅ 已评估：`emergence` 剩余主要是节点视觉指纹、首页品牌视觉和画布动效，先作为个性化例外
- 🚫 暂不处理：`report-agent`，由其他开发者负责

## 当前指标

- 扫描命令：`pnpm --prefix prd-admin run style:debt:owned -- --top 80`
- 排除边界：`prd-admin/src/pages/report-agent`
- 初始 owned debt：`45594`
- 当前 owned debt：`37730`
- 总下降：`7864`
- 本轮新增下降：`38832 -> 37747`
- `ai-toolbox` 首屏补强 + 公共 Shell/卡片统一：`37805 -> 37747`
- `ai-toolbox` 按统计页对齐 + Apple 式轻材质校准：`37747 -> 37805`（有意把卡片从整卡毛玻璃改为封面优先、底部轻材质信息层，增加项来自 shared styles 的局部透明色和小范围 blur，`ai-toolbox` 当前模块分为 `1345`）
- 公共导航 + `ai-toolbox` 统计页式低噪声卡片：`37805 -> 37792`（公共 `TabBar` 去掉内联玻璃样式，百宝箱工具卡改为 16:10 紧凑信息密度、弱化封面噪声并保留轻量强调色）
- `marketplace` 背景/顶部导航清理：`37792 -> 37745`（移除点阵、大光斑和品牌水印背景，顶部改用公共 `surface-nav-bar`）
- `/my-assets` 页面边界补漏：`37745 -> 37727`（移除主内容 `p-4` 二次缩进，顶部改用公共 `surface-nav-bar`，右侧概览/详情改为独立 `surface` 面板）
- `/ai-toolbox` 头部结构补漏：`37727 -> 37736`（有意增加少量共享 CSS 高光/active 状态，让页面级页签回到公共 `TabBar`，筛选/搜索独立成第二横条）
- `/ai-toolbox` 卡片标题层补漏：`37736 -> 37741`（有意增加少量 hover/focus 过渡和透明底部面板规则，换回封面优先、标题不再整卡铺开的层级）
- `/marketplace` 顶部和筛选二次收敛：`37741 -> 37744`（增加少量共享市场导航类，换回与统计页/百宝箱一致的紧凑工具条和 pill 尺度）
- `/marketplace` 接入 AI 新建页重构：`37744 -> 37726`（Start 页从大面积营销卡片改成紧凑向导表单，移除强制 88vh 空白）
- `/marketplace` 接入 AI 交互层级补漏：`37726 -> 37730`（右侧四项降级为只读能力清单，底部改轻量路径条，左侧只保留主/备两个真实入口）
- `components/ui`：`1302 -> 981`
- `lab-llm`：`1002 -> 486`
- `LlmLabTab.tsx`：`883 -> 367`
- `settings`：`1093 -> 435`
- `DailyTipsEditor.tsx`：`484 -> 194`
- `NavLayoutEditor.tsx`：`141 -> 45`
- `ThemeSkinEditor.tsx`：`153 -> 91`（剩余主要为皮肤预览动态样式）
- `workflow-agent`：`3616 -> 1908`（编辑页第二轮 `629 -> 303`，产物预览/HTTP 配置面板小补漏后对应文件已退出 top 80）
- `defect-agent`：`1823 -> 1278`（详情弹窗 `420 -> 229`，第二轮 `1632 -> 1278`，提交/分享面板已退出 top 80）
- `ai-toolbox`：`1860 -> 1345`（第二轮 `QuickCreateWizard.tsx` `541 -> 309`，`ToolEditor.tsx` `460 -> 275`，公共 Shell/卡片统一后 `ToolCard.tsx` `303 -> 215`，`ToolDetail.tsx` 当前 `259`）
- `ai-chat`：当前 `1305`
- `AdvancedVisualAgentTab.tsx`：`1464 -> 966`
- `document-store`：`1682 -> 1203`
- `DocumentStorePage.tsx`：`741 -> 492`
- `DocBrowser.tsx`：`756 -> 569`
- `components/model`：`791 -> 675`
- `weekly-poster`：当前 `1255`
- `literary-agent`：当前 `1256`
- `SkillAgentPage.tsx`：`936 -> 617`（第二轮 `879 -> 617`）
- `WorkflowCanvas.tsx`：已经不在 top 20 重灾文件里
- `marketplace`：`1024 -> 207`
- `SkillUploadDialog.tsx`：上传弹窗第一轮后剩余 `95`
- `MarketplacePage.tsx`：列表页第一轮后剩余 `62`
- `MarketplaceCard.tsx`：通用卡片第一轮后剩余 `14`
- `components/watermark`：`518 -> 276`
- `WatermarkSettingsPanel.tsx`：`477 -> 258`
- `emergence`：`1163 -> 959`
- `EmergenceCreateDialog.tsx`：`202 -> 99`
- `EmergenceInspireDialog.tsx`：`87 -> 34`
- `AssetsManagePage.tsx`：`363 -> 186`

## 页面边界统一准则

- ✅ `AppShell` 负责一级页面留白；业务页根节点不再额外套 `mx-auto`、`max-w-*`、`px-4/px-5`、`p-4` 作为页面外框。
- ✅ 顶部导航、筛选、搜索、主操作优先使用公共 `surface-nav-bar` / `surface-nav-tabs`，不再每页自造一条灰黑工具栏。
- ✅ 列表/卡片内容与顶部工具条对齐同一条左边界；只在卡片内部保留内容 padding。
- ✅ 右侧概览/详情用独立 `.surface` 面板和 `gap` 分隔，不用在主内容里再切一条竖线制造“套壳感”。
- 🚫 不通过给页面外层继续加大 padding 来“显得高级”；统一来自边界、层级、透明度和卡片语言一致。

## 已经做到哪里

### ✅ 阶段 1：基础设施

- ✅ 新增 Surface 迁移技能：`.agents/skills/surface-style-migration/SKILL.md`
- ✅ 拆分全局样式：`base.css`、`surface.css`、`motion.css`、`legacy.css`
- ✅ 新增 `Surface` 设计基础组件
- ✅ 新增样式债务扫描脚本
- ✅ 新增 `style:debt`、`style:debt:owned`、`style:debt:json` 命令

### ✅ 阶段 2：我们负责的高收益页面

- ✅ `StatsPage`
- ✅ `ai-toolbox`
- ✅ `defect-agent`
- ✅ `workflow-agent` 列表页
- ✅ `workflow-agent` 模板选择弹窗
- ✅ `workflow-agent` 演示页
- ✅ `workflow-agent` 编辑器稳定壳层

### ✅ 阶段 3：/mds 共享模型组件

- ✅ 模型列表行：去掉 JS hover 样式，改成统一类
- ✅ Token 展示：改成 token 文本色
- ✅ KPI rail：普通文字和图标改成 token 类
- ✅ 模型类型选择器：弹层、选项、hover、active 状态改成统一 Surface 类
- ✅ 浏览器预览 `/mds`：页面正常渲染，控制台无 error/warn

### ✅ 阶段 4：workflow-agent 画布稳定壳层

- ✅ 左侧舱目录面板
- ✅ 顶部浮动工具栏
- ✅ 日志侧边栏
- ✅ AI 侧边栏外壳
- ✅ 执行参数弹窗
- ✅ 节点编辑面板外壳
- ✅ connect drop menu
- ✅ 快捷键浮层
- ✅ 节点 context menu
- ✅ config input wrappers
- ✅ palette item hover
- ✅ 浏览器预览真实画布页：页面正常渲染，控制台无 error/warn

## 接下来做什么

### ✅ 已完成：workflow-agent 剩余稳定子壳

- ✅ connect drop menu
- ✅ 快捷键浮层
- ✅ 节点 context menu
- ✅ config input wrappers

### ✅ 已完成：ai-chat 稳定壳层第一轮

- ✅ `pages/ai-chat/AdvancedVisualAgentTab.tsx`
- ✅ 根容器、上传提示、快捷生成面板
- ✅ 顶部缩放工具栏、左侧工具栏、移动端底部工具栏
- ✅ 右侧聊天面板、模板入口、输入区、发送按钮
- ✅ 工具/新增/形状弹出菜单
- ✅ 保留画布坐标、缩放、拖拽、图片渲染、语义状态色

### ✅ 已完成：document-store 稳定壳层第一轮

- ✅ 创建知识库弹窗
- ✅ 编辑知识库弹窗
- ✅ 分享弹窗
- ✅ 详情页顶部操作区
- ✅ 访客、字幕生成、文档再加工抽屉外壳
- ✅ `DocBrowser` 右键菜单、标签弹窗、左侧浏览壳层
- ✅ 保留文档内容渲染、Markdown 代码高亮、进度条、文件类型色

### ✅ 已完成：weekly-poster 稳定壳层第一轮

- ✅ `pages/weekly-poster/WeeklyPosterEditorPage.tsx`
- ✅ 页面根、顶部栏、左侧列表、编辑顶部栏
- ✅ 普通输入框、正文 textarea、提示词 textarea
- ✅ 元信息卡片、页面卡片、说明提示区
- ✅ 保留海报 CTA 渐变、生成图片按钮、图片预览、主色调兜底渐变

### ✅ 已完成：literary-agent 配置管理第一轮

- ✅ `pages/literary-agent/ConfigManagementDialog.tsx`
- ✅ 作者信息、空状态、标题、内容预览、当前选择态
- ✅ 风格图配置列表的文字、分隔线、输入弹窗
- ✅ 保留市场 badge、fork 数、公开状态、图片棋盘背景等语义/内容视觉

### ✅ 已完成：SkillAgentPage 稳定壳层第一轮

- ✅ 页面根背景
- ✅ 顶部导航容器
- ✅ tab 容器和 active 状态
- ✅ 创建页阶段栏
- ✅ 思考中气泡和输入区
- ✅ 保留聊天气泡、技能分类色、头像渐变、运行状态色

### ✅ 已完成：SkillAgentPage 剩余普通面板第二轮

- ✅ 我的技能空状态、技能列表标题、标签、使用次数、删除按钮
- ✅ 未完成草稿列表标题、说明、继续/删除操作、普通分隔线
- ✅ 技能广场搜索框、搜索按钮、空状态、技能卡片普通文本和标签
- ✅ 技能详情页 SKILL.md 编辑面板、测试输入、输出结果面板
- ✅ 创建流程右侧自动测试、SKILL.md 预览、导出按钮、移动端导出栏
- ⚠️ 保留：分类/阶段 accent 色、头像/角色渐变、流式光标、发布/复制/下载状态色

### ✅ 已完成：ai-toolbox 第二轮可见统一

- ✅ `ToolEditor.tsx`：能力卡、工作流选择器、知识库上传区、会话配置区、模型提示区统一到 Surface/token
- ✅ `QuickCreateWizard.tsx`：测试聊天、右侧配置面板、模型下拉、知识库占位、温度摘要和步骤指示器继续收敛
- ✅ `ToolCard.tsx`：工具卡主体改为统一 interactive surface，普通操作图标和文字阴影归入共享样式
- ✅ `surface.css`：新增工具卡文字阴影工具类，避免卡片内继续散落 inline/text-shadow
- ✅ 浏览器预览 `http://127.0.0.1:8010/ai-toolbox` 正常渲染，无 500 和空白页
- ⚠️ 保留：封面图/视频、动态 hue、语义状态色、range 渐变、toggle 几何、头像/工作流兜底视觉

### ✅ 已完成：ai-toolbox 首屏可见第三轮 + 公共 Shell/卡片统一

- ✅ `AiToolboxPage.tsx`：去掉本页旧玻璃 TabBar，改成本页局部分段控件和统一 Surface 工具台
- ✅ `AiToolboxPage.tsx`：把页面切换、分类筛选、数量、搜索和创建按钮收进一个清晰的首屏操作区
- ✅ `ToolboxShell.tsx`：抽出百宝箱公共 Shell、页面页签、二级工具条和右侧操作位，避免两个页签各写一套顶部组件
- ✅ `ToolboxShell.tsx`：按“统计页”作为基准去掉内部 `mx/px` 外框，让顶部、列表和内容区回到同一左边界
- ✅ `BasicCapabilities.tsx`：接入公共 Shell，默认选中首个能力，统一能力列表面板、工作区面板和顶部统计
- ✅ `BasicCapabilities.tsx`：能力列表选中态改回统一 `surface-row[data-active]`，不再单独铺动态选中渐变
- ✅ `ToolCard.tsx`：卡片底部标题/描述/标签/统计改为独立信息面板，减少封面图直接压文字的旧遮罩观感
- ✅ `ToolCard.tsx`：卡片信息层扩展为统一 Surface 内容层，新增统一图标位，让封面图/视频退为弱背景
- ✅ `surface.css`：把百宝箱 Shell 和工具卡片从大面积毛玻璃改为 Apple 式轻材质：封面优先、底部信息层小范围 glass、边缘高光和克制阴影
- ✅ `ToolCard.tsx`：普通文字、标签、作者、统计线条继续 token 化，保留封面图/视频和动态 accent 色
- ✅ `surface.css`：新增 `toolbox-*` 专用类，使用 token 变量，不再把硬编码颜色扩散回组件
- ✅ 浏览器预览 `http://127.0.0.1:8010/ai-toolbox` 正常渲染，首屏变化肉眼可见

### ✅ 已完成：统计页基准再校准

- ✅ `TabBar.tsx`：把旧的 `glassStyles` 内联导航迁到 `.surface-nav-*` 公共样式，标题模式和 tabs 模式共用同一套横条语言
- ✅ `ToolboxShell.tsx`：百宝箱顶部工具台改用公共 `surface-nav-bar`，避免页面顶部再自造一套灰黑大框
- ✅ `ToolboxShell.tsx`：百宝箱页面级页签改为公共 `TabBar`，二级筛选/搜索拆成单独 `surface-nav-bar`，不再把两层导航塞进一个大头部
- ✅ `ToolCard.tsx`：工具卡从“封面图大背景 + 底部玻璃信息层”调整为统计页式低噪声卡片，16:10 紧凑比例、底部标题信息层、封面优先、保留少量 accent 色
- ✅ `ToolCard.tsx`：修正信息层 `absolute inset-0` 的整卡覆盖问题，默认只显示标题和一行说明，标签/收藏/状态在 hover/focus 时展开
- ✅ `MarketplacePage.tsx`：市场页去掉点阵背景、四角大光斑和装饰水印，顶部搜索/筛选/动作区改成公共导航横条
- ✅ `StartTab.tsx`：接入 AI 弹窗只保留左侧主/备两条可点击路径，右侧能力改为只读清单，底部改为轻量流程提示，避免四块区域都像按钮
- ✅ `/ai-toolbox` 浏览器预览：卡片密度更接近统计页，背景不再被封面图和大面积玻璃层抢视觉
- ✅ `/marketplace?type=skill` 浏览器预览：背景清爽，顶部导航与设置页/统计页同源
- ✅ `/settings?tab=assets` 浏览器预览：公共 `TabBar` 迁移后顶部页签正常渲染

### ✅ 已完成：页面左边界补漏

- ✅ `WorkflowListPage.tsx`：去掉列表页内部 `px-5` 二次缩进，工作流卡片与顶部导航对齐。
- ✅ `MarketplacePage.tsx`：去掉页面内部 `mx-auto max-w-7xl px-4` 外框，市场顶部、筛选和卡片回到同一页面边界。
- ✅ `DesktopAssetsPage.tsx`：顶部 tabs/search/sort/view/refresh 改用公共 `surface-nav-bar`，主内容去掉 `p-4`，右侧资产概览/详情改成独立 `.surface` 面板。
- ✅ `ToolboxShell.tsx`：百宝箱头部从自定义双层大壳改为“公共 TabBar + 独立筛选横条”。
- ✅ 浏览器截图已校对：`/my-assets`、`/workflow-agent`、`/marketplace` 与 `/executive` 左边界一致。

### ✅ 已完成：defect-agent 第二轮普通壳层统一

- ✅ `DefectSubmitPanel.tsx`：遮罩、Header、选择器、模板提示、描述编辑区、附件预览提示和严重性分段控件统一到 Surface/token
- ✅ `SharesListPanel.tsx`：搜索、全选、缺陷行、复制说明、历史分享卡片、评分表格统一到 Surface/token，并移除列表 hover JS 样式
- ✅ `DefectCard.tsx`：标题、时间、描述、附件 chip、底栏、人员 chip、灯箱遮罩等普通壳层继续收敛
- ✅ `StatsPanel.tsx`：加载/空态、统计标题、排行榜普通文本和条形背景 token 化
- ⚠️ 保留：严重程度色、状态/未读色、图片分析状态、分享评分数值色、附件真实预览

### ✅ 已完成：workflow-agent 稳定面板小补漏

- ✅ `ArtifactPreviewModal.tsx`：遮罩、预览弹窗、Header、下载菜单、空态、代码块、数据表格统一到 Surface/token
- ✅ `HttpConfigPanel.tsx`：URL 栏、Tab、KV 表格、Body/cURL 面板、导入导出按钮和响应提取字段统一到 Surface/token
- ⚠️ 保留：HTTP method 语义色、iframe 高度、Markdown/HTML 渲染字符串内部样式、ReactFlow 坐标/节点/连线/transform

### 🔄 后续重灾区顺序

1. ✅ `ai-toolbox` 工具编辑器第二轮、首屏可见第三轮、公共 Shell/卡片统一已完成，剩余主要是 `QuickCreateWizard`、`ToolEditor`、`ToolDetail` 内部子面板小补漏
2. ✅ `defect-agent` 卡片/提交/分享/统计第二轮已完成，剩余主要为状态色、附件预览和少量列表行边缘
3. ✅ `workflow-agent` 产物预览和 HTTP 配置面板小补漏已完成，剩余主要为画布/节点/模板/运行态例外
4. ✅ `emergence` 已评估：剩余主要为节点视觉指纹、首页品牌视觉和画布动效，不强行后台 Surface 化
5. ✅ `/settings?tab=assets` 已做可见样板页，剩余作为资源预览/状态色动态例外
6. ✅ `components/watermark` 已从重灾区降级，剩余作为预览/画布动态例外和小补漏
7. ✅ `marketplace` 已从重灾区降级，剩余作为品牌/动态例外和小补漏
8. ✅ `library` 作为公共品牌体验页记录例外
9. ✅ `settings` 已从重灾区降级，剩余作为动态/个性化例外记录
10. ✅ `home` 作为个性化品牌页记录例外

### ✅ 已完成：components/ui 共享组件第一轮

- ✅ `Tabs.tsx`：基础 tab 容器和 active 状态
- ✅ `ConfirmTip.tsx`：确认浮层壳层与文本 token
- ✅ `ContextMenu.tsx`：右键菜单壳层与菜单项文本
- ✅ `BottomSheet.tsx` / `MobileDrawer.tsx`：移动端弹层遮罩和面板
- ✅ `AvatarEditDialog.tsx`：头像预览、提示、错误态
- ✅ `UserProfilePopover.tsx`：个人资料弹层普通信息区
- ✅ `GlobalDefectSubmitDialog.tsx`：全局缺陷提交弹窗普通壳层
- ⚠️ 保留：角色色、缺陷收/发计数色、附件分析状态、API 日志 method/status/duration 颜色

### ✅ 已完成：lab-llm 稳定壳层第一轮

- ✅ `pages/lab-llm/LlmLabTab.tsx`
- ✅ 左侧实验配置、模型集合、已选模型分组
- ✅ 顶部模式提示、数量输入、图片比例下拉菜单
- ✅ 识图上传区、提示词 textarea、系统提示词解锁遮罩
- ✅ 推理/识图结果空状态、结果卡片、输出预览、复制/展开按钮
- ✅ 单张/批量生图的普通分组壳层、提示文字、确认弹窗、加载/新建实验弹窗
- ⚠️ 保留：图片缩略图尺寸、选择边框、下载/复制悬浮按钮、运行状态色、`gridTemplateColumns`、图片 `objectFit`

### ✅ 已完成：settings 普通设置页第一轮

- ✅ `DailyTipsEditor.tsx`：根容器、表单字段、提示条、列表行、空状态、推送弹窗、自动引导面板
- ✅ `NavLayoutEditor.tsx`：顶部说明、导航槽、可添加池、导航 chip、分隔 chip、计数 badge
- ✅ `UserSpaceSettings.tsx`：私人空间引导卡、区块头、工具行、统计 badge、空状态
- ✅ `MyFavoriteSkills.tsx`：收藏技能区块头、加载/空状态、收藏行、标签、取消收藏按钮
- ✅ `AccountSettings.tsx`：账户信息头部、头像预览、错误提示、只读信息行
- ✅ `UpdateAccelerationSettings.tsx`：说明卡、缓存记录、状态行、链接/删除图标
- ✅ `ThemeSkinEditor.tsx`：标题、保存状态、重置按钮、普通文字 token 化
- ⚠️ 保留：皮肤预览动态背景/透明度、拖拽 drop 高亮、工具/技能 accent 色、缓存状态色

### ✅ 已完成：marketplace 普通壳层第一轮

- ✅ `SkillUploadDialog.tsx`：遮罩、弹窗、Header、Footer、普通字段、标签、错误提示、空态
- ✅ `SkillOpenApiDialog.tsx`：遮罩、弹窗、Header、Tab、滚动区域；`新建接入` 页改为自适应高度，Key 列表/指南页保留高弹窗
- ✅ `skillOpenApi/StartTab.tsx`：借鉴 Key 创建/安装向导，改为“左侧选方式 + 右侧能力/安全说明 + 底部轻步骤条”，消除中段空白
- ✅ `skillOpenApi/KeysListTab.tsx`：加载态、空态、Key 列表行、统计字段、权限标签、普通操作按钮
- ✅ `skillOpenApi/CreateKeyTab.tsx`：输入框、权限选择卡、有效期选择、成功态、警告态、主 CTA
- ✅ `skillOpenApi/GuideTab.tsx`：下载技能包、快速上手、代码区、订阅说明区
- ✅ `MarketplacePage.tsx`：顶部导航、搜索框、排序按钮、接入 AI 按钮、筛选面板、标签筛选、空状态
- ✅ `MarketplacePage.tsx`：顶部工具条从大标题/大搜索框收敛为紧凑导航；分类和标签筛选改为统一 `marketplace-nav-pill` / `marketplace-tag-pill`
- ✅ `MarketplacePage.tsx`：移除动态背景的 `fixed` 附着，避免市场页继续像独立营销页，回到后台页面清爽层级
- ✅ `MarketplaceCard.tsx`：官方 badge、标题文本、底栏边框/文本、hover 阴影迁到统一样式层
- ⚠️ 保留：市场背景海报、品牌装饰层、类型图标/标签色、上传封面预览、Key 状态色、代码内容、演示视频、上传区拖拽态

### ✅ 已完成：components/watermark 普通壳层第一轮

- ✅ `WatermarkDescriptionGrid.tsx`：说明网格改成 `surface-inset` 和 token 文本
- ✅ `ColorPicker.tsx`：选择器容器和弹层改成 `surface-*`
- ✅ `WatermarkSettingsPanel.tsx`：列表卡片标题、授权/测试按钮、底栏、发布/选择/编辑/删除按钮、空状态
- ✅ `WatermarkSettingsPanel.tsx`：编辑弹窗右侧表单面板、预览标签、底部上传按钮、定位/缩放分段控件
- ✅ `WatermarkSettingsPanel.tsx`：文字/填充/边框开关、图标上传入口、放大预览遮罩
- ⚠️ 保留：水印预览画布尺寸、拖拽定位、透明棋盘格、动态 range 渐变、文字/边框/背景真实颜色、边距输入、测量/transform 几何样式

### ✅ 已完成：emergence 弹窗/popover 普通壳层第一轮

- ✅ `EmergenceCreateDialog.tsx`：遮罩、弹窗、标题区、输入框、模式 tab、模板卡、系统能力区、错误提示
- ✅ `EmergenceInspireDialog.tsx`：遮罩、弹窗、Header、textarea、快捷灵感、Footer
- ✅ `EmergenceEmergePopover.tsx`：弹层、说明区、二维/三维选项、图标容器、普通文本
- ⚠️ 保留：拖拽上传态、维度强调色、节点卡视觉指纹、流式状态色、首页品牌视觉、画布/动画/粒子/几何定位

### ✅ 已完成：workflow-agent 编辑页稳定壳层第二轮

- ✅ `WorkflowEditorPage.tsx`：产物操作按钮、执行结果面板、日志侧栏、最终产物列表、变量区统一到 Surface/token
- ✅ 左侧舱目录和顶部工具条的普通文本/边框/背景继续收敛
- ✅ 日志面板复用统一 workflow log/step/progress 类
- ⚠️ 保留：节点动态 hue、执行进度动画、断点/运行状态色、语法高亮、ReactFlow/模板 HTML 相关运行时视觉

### ✅ 已完成：defect-agent 详情弹窗第一轮

- ✅ `DefectDetailPanel.tsx`：遮罩、弹窗外壳、Header、Footer、缺陷编号、评论区 Header、评论输入区统一
- ✅ 图片/普通附件/日志附件、问题描述、解决/驳回/验收提示改成 Surface/token 类
- ✅ 评论空状态、消息附件、待发送附件、基础图标和文本 token 化
- ⚠️ 保留：严重程度/状态色、聊天头像角色色、图片灯箱、附件预览尺寸、评论气泡少量语义差异

### ✅ 已完成：资源管理页可见统一样板

- ✅ `AssetsManagePage.tsx`：页面 tab、资源分组、上传块、单文件资源卡、矩阵卡片、表格壳层统一到 Surface/token
- ✅ 表单输入、说明文字、代码路径、空预览、删除/替换操作按钮统一到 `.prd-field`、`.text-token-*`、`.surface-*`
- ✅ 浏览器预览 `http://127.0.0.1:8010/settings?tab=assets` 正常渲染，当前用户看到的页面已是本轮改造结果
- ⚠️ 保留：图片/视频真实预览、上传占位渐变、资源状态 badge、动态列宽/比例/尺寸、品牌图像内容样式

## 不要做什么

- 🚫 不碰 `report-agent`，除非负责人明确要求迁移
- 🚫 不追求债务分数清零
- 🚫 不机械替换画布坐标、拖拽、缩放、transform、ReactFlow 几何样式
- 🚫 不替换有业务含义的数据颜色、图表颜色、运行状态颜色
- 🚫 不破坏动态 hue：例如 `hsla(${hue}, ...)`
- 🚫 不把大交互页面一次性重写，先抽稳定子组件和壳层

## 要怎么做

- ✅ 普通面板、弹窗、列表行、空状态：用 `Surface`、`.surface-*`
- ✅ 普通文字颜色：用 `.text-token-*`
- ✅ 普通边框/背景：用 `.border-token-*`、`.bg-token-*`
- ✅ 普通输入框：用 `.prd-field`
- ✅ JS hover mutation：能用 CSS hover 就迁移
- ✅ 动态运行时样式：保留，但尽量缩小范围并写清楚原因

## 每轮完成标准

- ✅ TypeScript 通过
- ✅ 生产构建通过
- ✅ 样式债务分数下降，或剩余项明确属于例外
- ✅ 浏览器预览无明显错位、遮挡、空白页
- ✅ 不越过 ownership 边界

## 最近验证结果

- ✅ `pnpm --prefix prd-admin tsc` 通过
- ✅ `pnpm --prefix prd-admin build` 通过
- ✅ `pnpm --prefix prd-admin run style:debt:owned -- --top 20` 通过，当前 `37730`
- ✅ `git diff --check` 通过
- ✅ 本地预览服务可访问：`http://127.0.0.1:8010/`
- ✅ 本轮环境修复：后端需在沙箱外连接本机 MongoDB/Redis，并监听 `localhost:5001`；前端明确监听 `127.0.0.1:8010`
- ✅ 已完成关键截图校对：`/executive`、`/ai-toolbox`、`/my-assets`、`/workflow-agent`、`/marketplace`、`/mds`、`/settings?tab=assets`、`/document-store`、`/assets`
- ⚠️ 未声明完成：全站所有路由、所有滚动深度、所有弹窗/抽屉状态的逐屏截图校对
- ⚠️ 校对结论：统计页仍是当前视觉标尺；`/workflow-agent`、`/marketplace`、`/my-assets` 左边界已对齐；`/marketplace` 本轮进一步压缩顶部工具条、分类筛选条，并重构接入 AI 新建页，最新补漏已把弹窗四块相似卡片改成主入口、次入口、只读清单和轻量路径条
- ✅ `/settings?tab=assets` HTTP 200：`http://127.0.0.1:8010/settings?tab=assets`
- ✅ `/settings?tab=assets` 浏览器预览通过，页面无空白、资源分组和上传块正常显示
- ✅ `/ai-toolbox` HTTP 200：`http://127.0.0.1:8010/ai-toolbox`
- ✅ `/ai-toolbox` 浏览器预览通过，页面无空白、工具列表和创建入口正常显示，公共 Shell、基础能力页和底部透明卡片信息面板已更新
- ✅ `/defect-agent` 浏览器预览通过，页面无 500、主内容正常显示
- ✅ `/workflow-agent` 浏览器预览通过，页面无 500、主内容正常显示
- ✅ 历史验证 `/settings` HTTP 200：`http://127.0.0.1:8013/settings`
- ✅ `/mds` HTTP 200：`http://127.0.0.1:8013/mds`
- ✅ `/skill-agent` HTTP 200：`http://127.0.0.1:8013/skill-agent`
- ✅ `/marketplace?type=skill` HTTP 200：`http://127.0.0.1:8013/marketplace?type=skill`
- ✅ `/workflow-agent`、`/defect-agent`、`/emergence`、`/mds` 路由返回 HTTP 200
- ✅ `/weekly-poster/advanced`、`/skill-agent`、`/literary-agent` HTTP 200
- ✅ `/workflow-agent/:id/canvas` 浏览器预览通过
- ✅ `/document-store` 浏览器预览通过
- ✅ `/document-store` 新建知识库弹窗预览通过
- ⚠️ 构建仍有原有 Vite chunk/import 警告，不是本次样式迁移引入的阻塞问题
- ⚠️ 浏览器日志里仍能看到此前 workflow 页面留下的 ReactFlow 容器尺寸 warning，当前 `/mds` 和 `/document-store` 预览未出现 HTTP 500 或空白页
