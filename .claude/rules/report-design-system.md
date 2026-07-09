# 米多刊系（Miduo Press）—— 汇报产物视觉设计系统

> 系统的四种汇报产物（日报 / 周报 / 验收报告 / 每日视觉验收报告）是**一家出版社的四份刊物**：
> 共享同一套纸墨基因（视觉统一），各自保留一个身份色与版式个性（个性化设定）。
> 触发：编辑任何报告模板（`daily-report-summary` / `weekly-update-summary` / `create-visual-test-to-kb` 的 HTML 模板或生成脚本）。

---

## 一、共享基因（所有刊物必须一致，禁止各自发明）

### 1.1 色彩 token（纸墨系）

| Token | 值 | 用途 |
|---|---|---|
| `--paper` | `#f7f1e8` | 页面底色（暖纸） |
| `--paper-2` | `#fffdf8` | 卡片/面板表面 |
| `--ink` | `#211d18` | 主文字/主线条（油墨黑） |
| `--ink-2` | `rgba(33,29,24,0.74)` | 正文次级 |
| `--ink-3` | `rgba(33,29,24,0.48)` | 弱化说明/mono 小标 |
| `--line` | `rgba(33,29,24,0.14)` | 细分隔线 |
| `--line-2` | `rgba(33,29,24,0.30)` | 强分隔线 |

语义色全刊系统一：通过 `#1a7f37`、警示/有条件 `#9a6700`、失败 `#b42318`。

### 1.2 字体三栈

- 衬线 `--serif`（Source Serif 4 / Songti SC / Noto Serif SC）：大标题、刊名、数字大字
- 无衬线 `--sans`（PingFang SC / HarmonyOS Sans SC）：正文
- 等宽 `--mono`（SF Mono / JetBrains Mono）：kicker 小标（配 `letter-spacing: 0.14em+`）、期号、PR 号、数据标签

### 1.3 版面签名元素（认出「这是米多的报告」靠这些）

1. **报头 masthead**：色块 stamp（"MAP"，身份色底 + `3px 3px 0` 硬投影）+ 衬线刊名 + mono 英文刊名 + 底部粗墨线（日报 2.5px 单线；周刊/档案 3px+1px 双线）
2. **期号 dateline**：mono 小字横条，关键数字用身份色加粗
3. **硬投影**：`Npx Npx 0 rgba(33,29,24,x)`，禁止柔和大模糊阴影
4. **kicker**：mono + 宽字距 + 身份色的栏目眉（如「封面故事 · COVER STORY」）
5. **数据页脚 stat-row + 刊尾 colophon**：衬线大数字统计条 + mono 版权行
6. **版画插图**：内联 SVG，油墨 + 身份色双色、hatch 纹理、描边为主（禁 data:image）
7. **纯 CSS 图表**：横条 hbar / 竖条 vchart / 瀑布格 waffle / 堆积条 stack，数字一律来自 git 真实数据

### 1.4 硬约束（全刊系）

- **移动端可见**：必带 `<meta viewport>`；双栏 `@media(max-width:760px)` 塌单栏；表格包 `overflow-x:auto` 容器；`@media(max-width:640px)` 收内边距
- **自包含**：内联 CSS，无外部 http 资源
- **禁 emoji**（CLAUDE.md 规则 0）；重要程度用文字分级 + 色彩
- 知识库渲染的刊物（日报/周报）额外禁 `<script>`、禁 `data:image`（publish.py 硬闸）；CDS 渲染的刊物（验收/巡检）允许 `<script>` 做筛选/折叠交互

---

## 二、四刊个性设定（一刊一色一版式，禁止互相串味）

| 刊物 | 定位隐喻 | 身份色 | 版式个性 | 模板/生成器 | 去向 |
|---|---|---|---|---|---|
| **日报** | 日报纸（今日大事早知道） | 赭红 `--terra: #c05b3c` | 报纸版：TL;DR 头版 + 头条展开 + 优化/修复双栏 + 数据版 | `daily-report-summary/reference/report-template-html.html` | 知识库「日报知识库」 |
| **周报** | 周刊杂志（一周纵深读本） | 靛蓝 `--indigo: #4f46e5` | 周刊版：封面故事 + 一周脉络时间轴 + 深度报道 + 数据版 + 落地对照 + 下周优先级 | `weekly-update-summary/reference/report-template-html.html` | 知识库「周报知识库」（md 底稿仍落 `doc/report.YYYY-WXX.md`） |
| **验收报告** | 检验档案（一事一档） | 青碧 `#0f766e` | 档案版：深墨证据导航侧栏 + 刊头 + 手写体验定印章（rotate 的双框 badge）+ 指标条 + 证据版面 | `create-visual-test-to-kb/scripts/archive_report.py :: build_interactive_html(flavor="acceptance")` | CDS 验收中心 |
| **每日视觉验收** | 巡检特刊（每日全量巡查） | 钢蓝 `#3b5f8a` | 同档案版结构，刊头换「每日巡检特刊 DAILY PATROL EDITION」 | 同上 `flavor="daily"`（`_report_flavor` 按 `_declares_daily_acceptance` 自动判定） | CDS 验收中心 |

判定口诀：**纸墨基因认出出版社，身份色和刊头认出是哪份刊。** 新增第五种汇报产物时，先从本表选隐喻 + 分配一个不冲突的身份色，再复用共享基因，禁止从零起一套风格。

---

## 三、兼容红线（改皮不改骨）

1. **验收 HTML 模板契约不许动**：`data-template="map-acceptance-interactive-html-v2"`、`map-acceptance-template` 标记、结构 class（`layout` / `hero` / `evidence-nav` / `reportBody`）被 `cds/src/routes/reports.ts::validateAcceptanceHtmlTemplate` 与 `scripts/test-acceptance-archive-report-gates.py` 双重校验——皮肤重设计只改 CSS 与装饰性结构，改完必跑 gate 测试。
2. **内容分层权重不随皮肤变**：日报纪律 1（新增多讲）、周报纪律 5（数字来自 git）、验收标准 v2（证据闭环）都在各自 SKILL.md，模板只管「长什么样」。
3. **发布校验同一口井**：知识库刊物统一走 `daily-report-summary/reference/publish.py`（周报用 `--store 周报知识库 --kind weekly-report`），自包含/禁脚本/viewport 校验不许旁路。

---

## 历史背景

2026-07-07 用户提出：四种汇报产物风格割裂——日报（报纸版）最佳、周报还是裸 md、验收报告"凑合"、每日视觉验收"复杂但不美观"；要求做视觉统一或个性化设定，且不希望把日报风格原样复制到每种报告，移动端也要可见。本规则把「一社四刊」的方案固化：共享纸墨基因保统一，一刊一色一版式保个性。
