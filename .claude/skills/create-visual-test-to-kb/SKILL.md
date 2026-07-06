---
name: create-visual-test-to-kb
version: 1.0.0
description: 工业级功能验收/视觉测试全流水线（MAP 验收标准 v2）——模拟人类的浏览器取证 + 标准化验收报告 + 归档进 CDS 验收中心并出直达深链。职责分离：验收报告永远按项目归 CDS（平台自带、证据链内置），MAP 等系统通过知识库开放协议从 CDS 拉取展示，技能不再分流到 MAP 知识库。一个技能内含三段：标准/模板、模拟人类浏览器取证（点击导航进入、禁地址栏直达、双主题截图、ZZ 照做风画框标序号 stepClick/stepShot）、报告归档（命名结构固定，**每次归档强制输出可达地址**：CDS 直达深链 /reports，匿名对外用 /r/token）。默认报告走 **ZZ 照做风**（全大标题 + 一句话一步 + 逐步配图 `{{IMG:}}` + 文字在上图在下 + 变化处画框 + 分支顺序讲，同岗位照做必复现）。归档前有**强制准入校验**：目标/档位/Verdict/截图数/证据完整性/报告结构不达标直接拒收（入口准则，杜绝"什么都能进"）。项目无关，改 acceptance.config.json 即可跨仓库复用；无 CDS/离线退化为本地 md+截图。触发词："视觉验收"、"验收"、"视觉测试"、"验收归档"、"归档验收报告"、"create visual test"、"/视觉验收"、"/验收"。
---

# 验收归档 v2 — 工业级功能验收全流水线

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/验收`、`/视觉验收`、"视觉验收"、"验收"、"视觉测试"、"验收归档"、"create visual test"

> 一条不可分的流水线:**标准定义测什么/怎么截/怎么命名 → 模拟人类浏览器取证 → 证据落 CDS 验收中心出直达深链**。
> 主纲在此,完整规则按需加载(见下"按需文件")。**先读 `reference/standard-v2.md`**——那是下限基线,不是参考是必读。

## 何时用

- 一个功能/PR 开发完成,需要可查收、可追溯、结构化的验收报告(替代塞 PR 评论 / 塞 HTML 进 doc/)。
- AI 自测完(CLAUDE #8.1)后,以**真人路径**复验并归档结论 + 证据。

## 前置依赖（接入即查,缺一不可)

| 依赖 | 用途 | 怎么装/拿 |
|------|------|----------|
| **Playwright + Chromium** | harness 跑无头浏览器取证 | `npm i -g playwright && npx playwright install chromium`;运行时设 `PWPATH=$(npm root -g)/playwright` |
| **Python 3** | 跑 `archive_report.py` | 系统自带 |
| **登录凭据 env** | harness 表单登录(被验收应用) | `MAP_AI_USER`(用户名)、`MAP_ACCEPT_PASS`(密码)。**禁止写进文件**,运行时 export |
| **CDS 归档 env**(默认 cds 模式) | 落 CDS 验收中心鉴权 | `CDS_HOST`(如 cds.miduo.org) + (`CDS_PROJECT_KEY`=项目级 cdsp_* 最小权限,推荐;或 `AI_ACCESS_KEY`=全局)。**禁止写进文件**,运行时 export |
| **cdscli** | 取预览域名 + report/report-folder 命令 | 仓库内 `.claude/skills/cds/cli/cdscli.py`;没有就在 config 填 `previewUrlOverride` |

`report.mode=local` 时**只需 Playwright + Python**,不需要任何密钥/网络——报告写本机临时目录,默认 `/tmp/map-acceptance-local`。不得写入仓库内 `doc/acceptance/`。
`report.format=html` 是每日验收默认交付格式。报告正文仍用 Markdown 写作,归档脚本会转换成交互 HTML,提供证据导航、指标卡、证据缩略图、表格筛选、章节折叠和图号锚点跳转。HTML 与 Markdown 必须使用不同模板:Markdown 保持审计文本结构不变,HTML 才启用更强的视觉和交互阅读层。只有下游系统明确要求 Markdown 时才改 `format=md`。

接入新仓库:见文末"跨仓库复用",改 `acceptance.config.json` 一处即可。

## 三个核心规矩(v2 相对 v1 的升级,违反即不合格)

1. **模拟人类,禁地址栏直达**:登录后用 `gotoByClick(可见文本)` 点击导航进入目标页,`page.goto` 只许用于登录页。**从导航点不到目标页 = P1 缺陷**(功能做了但用户找不到/没进菜单)——这是 goto 直达永远测不出的真问题。
2. **人类可读优先**:报告首屏是"验收速览卡"(Verdict + 一句话结论 + 元信息表),不是 YAML。
3. **命名 + 防 `---`**:报告名业界状态前置 `[{verdict_cn}] {目标} · 验收报告 · {项目} · {日期}`;正文必须以 `# 标题` 打头(目录显示名取 summary 首行,见标准 §2.1)。`archive_report.py` 已内置,手工归档也照此。
4. **准入门槛(入口准则)**:归档前强制校验——目标有意义、档位/Verdict 合法、截图数达档位下限、证据完整、报告结构齐、无半成品残留;**任一不达标直接拒收、不写库**(见标准 §3.5)。输入不对,输出不可能对。
5. **证据文件不进代码库**:截图、录屏、临时 HTML、manifest、报告草稿等验收产物必须写到 `/tmp`、系统临时目录、对象存储或知识库,**禁止落到 git 仓库目录内**。默认配置已把 `screenshot.outDir` 与 `report.localOutDir` 指向 `/tmp`;`harness.mjs` 和 `archive_report.py` 会拒绝仓库内截图路径。归档前必须看一眼 `git status --short`,发现 `*.png/*.jpg/*.jpeg/*.webp/*.gif/*.mp4/*.webm` 或 `doc/acceptance/`、`acceptance-*`、`peer-sync-effect-*.html` 这类验收产物在仓库内,先移到 `/tmp` 或删除,不得提交。
6. **比例原则**:严格不等于吹毛求疵。测试深度必须由风险、用户影响和证明力决定;低风险、非运行态、观察型问题不得被包装成 P0/P1。报告必须说明为什么当前深度足够,也必须说明继续加测不会改变 Verdict 的边界。
7. **问题可定位**:凡报告写 P0/P1/P2 视觉问题,读者必须能从图里 3 秒定位。缺陷行要写清`位置 + 阻挡物/异常物 + 被影响对象 + 用户影响`,证据图必须有红/橙框或圈和短标签。只写"遮挡""异常""看这里"不合格。

## 复杂验收前置（每日/PR/commit/未发布分支/缺陷复测/视觉回归/发布前必用）

当用户要求每日验收、昨天验收、PR 验收、commit 验收、未发布分支验收、缺陷复测、视觉回归或发布前验收时,先使用 `acceptance-test-design` 生成「验收测试设计稿」,再使用 `acceptance-scenario-orchestrator` 生成「验收场景编排」,最后执行本技能。该编排必须给出:

- `改动断言 -> 影响面 -> 风险假设 -> 融合测试 -> 证明力矩阵 -> 覆盖缺口` 的测试设计链。
- `PR/commit -> 归属模块 -> 页面位置 -> 预期结果 -> 证据要求` 的映射。
- `PR/commit -> changed files -> 改动断言 -> 用户可见页面/状态 -> 必要证明 -> 实际证据 -> 关联性结论` 的映射。
- 每个测试单元开测前的指差法说明:现在开测哪个 PR/commit、归属于哪个功能模块、页面面包屑是什么、预期看到什么。
- 不可视觉验收项的替代证据类型,如 API、日志、文件规则或环境状态,并解释为什么没有用户可见页面证据。
- 未发布分支的 branch/preview URL/commit SHA/容器状态,并明确环境可达不等于功能通过。

执行和报告必须能反查测试设计稿与场景编排。任何 PR/commit 未出现在最终结果里,都视为覆盖缺口。

每日/昨日自动验收必须先跑机器盘点:

```bash
python3 .claude/skills/acceptance-test-design/scripts/daily_scope.py \
  --date <YYYY-MM-DD> \
  --json-out /tmp/daily-scope.json \
  --md-out /tmp/daily-scope.md
```

后续测试设计必须以 `/tmp/daily-scope.json` 为范围输入,不得只凭 `git log` 摘几条或只看 main。若 JSON 中存在 open PR、未发布分支或高风险模块,报告必须在「未发布状态」和「改动规模与深度预算」中逐项交代覆盖/未覆盖结论。

官方 `create-visual-test-to-kb` 下载包已内置 `acceptance-test-design` 与 `acceptance-scenario-orchestrator`。只有在使用旧包或手工补装依赖时,才按下面命令安装;执行前必须把 `PRD_AGENT_BASE` 设为当前 PRD Agent API 根地址(例如 `https://your-host`),否则不要运行:

```bash
test -n "${PRD_AGENT_BASE:-}" || { echo "请先 export PRD_AGENT_BASE=https://你的 PRD Agent 域名"; exit 1; }
curl -sSLo /tmp/acceptance-test-design.zip "$PRD_AGENT_BASE/api/official-skills/acceptance-test-design/download" \
  && unzip -o /tmp/acceptance-test-design.zip -d "${CODEX_HOME:-$HOME/.codex}/skills/"
curl -sSLo /tmp/acceptance-scenario-orchestrator.zip "$PRD_AGENT_BASE/api/official-skills/acceptance-scenario-orchestrator/download" \
  && unzip -o /tmp/acceptance-scenario-orchestrator.zip -d "${CODEX_HOME:-$HOME/.codex}/skills/"
```

若暂时无法安装依赖,不要跳过前置设计:在本技能内按 `验收测试设计稿 -> 验收场景编排 -> 截图归档` 的顺序手写同名章节,并把缺失依赖记入报告风险。

## 自动化任务契约（自动化只做调度壳）

每日 6 点这类 cron 自动化只负责调度和注入运行上下文,验收规则必须由技能链维护。自动化 prompt 只允许保留:

- 工作目录、目标日期规则、允许的预览测试数据前缀和禁止触碰生产破坏性数据。
- Slack 通知目标,如 `#map` / `C0B23U0V9U4`。
- 必要 env 名称,如 `MAP_AI_USER`、`MAP_ACCEPT_PASS`、`MAP_DOC_STORE_KEY`、`AI_ACCESS_KEY`;禁止写入明文账号密码。
- 必用技能链:`acceptance-test-design -> acceptance-scenario-orchestrator -> create-visual-test-to-kb`。
- 一句话说明:报告结构、深度门禁、CDS ready、归档、`verify-open` 和失败降级均以本技能为准。

自动化 prompt 不得复制维护每日验收章节、截图数量、颜色标记、CDS 检查细则、报告模板或 Slack 长格式。规则只在技能中改,避免 prompt 与技能漂移。

自动化启动后必须先执行这些运行门禁:

- 读取当前仓库 `AGENTS.md`;保持 tracked 工作区干净,不得在旧 worktree 或脏 worktree 上验收。
- 同步目标基线到最新远端代码。每日验收默认 `git fetch --all --prune` 后测试最新 `origin/main`,并在报告和 Slack 同时记录 `测试 commit` 与 `origin/main commit`。二者不一致必须解释原因。
- `MAP_AI_USER` / `MAP_ACCEPT_PASS` 只用于 MAP 登录;CDS API、知识库写入和 Slack 不能误用这两个账号密码。
- 缺少 `MAP_AI_USER`、`MAP_ACCEPT_PASS`、`MAP_DOC_STORE_KEY` 或 `AI_ACCESS_KEY` 时,仍必须生成失败报告并通知 Slack,不能静默退出或只报本地错误。

## CDS 预览 ready 门禁（自动化/每日验收强制）

每日验收开始取证前必须证明被测预览环境真的可测:

- 预览域名和 branch 信息只能来自 `python3 .claude/skills/cds/cli/cdscli.py --human preview-url` 及 cdscli/API 查询结果;禁止手拼 `miduo.org`。
- 必须检查目标 branch 的部署状态和 smoke 结果。状态为 building、starting、stopped、error、missing,或 smoke 非 0 时,最多每 30 秒重试一次,总等待不超过 15 分钟。
- 15 分钟后仍未 ready,这轮每日验收判链路可运行但产品环境不可验,生成线上失败报告并通知 Slack。不得把登录页、构建中页面、503 页面、CDS shell 截图当作功能证据。
- 取证过程中遇到 503/502/preview not ready,必须在报告「重试记录」写清每次 URL、HTTP 状态、时间和最终结论。偶发一次后重试通过可以继续,但首试失败不能从报告里抹掉。

## CDS 平台与 CDS Agent 证据边界

`CDS` 和 `CDS Agent` 是两类验收对象,不能互相替代:

- `CDS 平台`: `cds/` 下的部署、预览、报告中心、branch network、extra-services、self-update、scheduler、proxy、smoke、CDS CLI/API 等。有效证据是 cdscli/API branch status、deploy/smoke 输出、`/reports` 页面、preview routing 结果、服务状态、日志或报告归档结果。
- `CDS Agent`: prd-admin 的 `/cds-agent` 工作台、CdsAgent adapter/event renderer、runtime/session/tool-call 流程。有效证据是 `/cds-agent` 页面、会话状态、runtime events、相关 API 响应。
- 每日验收报告里,凡是 `CDS 预览/部署/报告中心/分支网络/extra-services/self-update/scheduler/proxy` 断言,不得用 `CDS Agent 页面可见` 或 `/cds-agent` 截图判通过。若两者都变更,必须拆成两个改动断言和两条证据链。
- `CDS Agent 入口可见` 最多证明 CDS Agent 工作台入口可见,不能证明 CDS 平台部署、预览、报告归档或 branch ready。

## 交互 HTML 报告（每日验收默认）

每日验收报告应交付 HTML,不是纯 Markdown 长文:

- 写作源仍是 Markdown 模板,继续使用 `{{IMG:name}}`、证据表、缺陷表和截图回读表。
- `format=md` 输出写作源的原始审计结构,保持现有 Markdown 格式不变。
- `format=html` 使用独立阅读模板,归档脚本负责生成顶部结论区、指标卡、证据缩略图、左侧证据导航、图号锚点、表格搜索、按未通过/有缺陷/未覆盖过滤、章节折叠。
- HTML 交互只用于阅读和定位证据,不得把验收结论只藏在 JS 状态里。核心结论、缺陷、未覆盖项仍必须以正文表格存在,保证 raw 内容和跨系统同步可读。
- 不要手写复杂前端应用或远程依赖。报告 HTML 必须单文件可归档,截图走 CDS report assets,总正文仍受 10MB 上限约束。

## 线上报告与通知门禁（自动化/每日验收强制）

每日自动化的交付入口必须是线上可打开地址:

- Slack 禁止发送 `/tmp`、`file://` 或本机 HTML 作为报告入口。报告 HTML/Markdown 必须发布到 CDS 验收报告页或 MAP 知识库分享链;优先 CDS 自托管报告,失败再回退 MAP 知识库。
- 通知里出现的报告链接、raw 链接和页面链接必须同源且可由接收者打开。raw 内容验证通过不等于页面验证通过。
- 归档后必须跑 `scripts/verify-open.mjs`,默认 3 次重试,同时等待标题、正文和图片。三次都失败时判验收链路失败;若第 2/3 次通过,报告必须记录首试失败和最终通过次数。
- 如果所有线上归档路径都失败,仍要把本地报告路径写入失败报告摘要,但 Slack 结论必须写「线上归档失败」,不能伪装为已完成。
- Slack 摘要保持短格式:总 Verdict、线上报告链接、测试 commit、origin/main commit、缺陷数量、未覆盖数量、归档结果、打开验证结果。详细证据放报告,不要塞进 automation prompt。

## 证据关联性门禁（2026-06-20 反哺）

> 事故反哺：用户指出“知识库同步功能变更，却只截知识库列表页”，这是模块相邻，不是行为证明。验收报告必须证明提交信息里的行为，不是证明同一模块的某个页面能打开。

- 每个 PR/commit 必须先抽取「改动断言」：这次代码声称改变了什么可观察行为。不要先决定截图页面。
- 每条改动断言必须写「必要证明」：最小可证明动作或状态。例如同步功能要开测同步动作、同步结果、同步日志或接口返回；不能用列表页可见替代。
- 报告必须包含「改动断言到证据表」,列为: `PR/commit`、`changed files`、`改动断言`、`必要证明`、`实际证据`、`关联性`、`结论`。
- `关联性` 只允许: `相关`、`弱相关`、`无关`、`未覆盖`。只有 `相关` 可以支撑 pass；`弱相关` 最多支撑有条件通过；`无关/未覆盖` 必须进入缺陷或未覆盖项。
- `列表可见`、`页面可达`、`按钮可见` 只证明入口/承载可用。除非提交本身改的是入口、路由、布局或按钮显隐，否则不得作为该提交通过证据。
- 同步、恢复、上传/压缩、鉴权、异步任务、外部下载、部署/canary、状态流转、数据写入类改动必须至少有一个动作/结果证据或 API/log/state 证据。无法安全触发时标 `未深测`，不能用邻近页面截图顶替。
- CDS 平台改动必须走 CDS 平台证据,不能用 CDS Agent 页面顶替。报告中出现“CDS 预览/部署/报告/branch/extra-services/self-update/scheduler/proxy”与“CDS Agent 页面”绑定为通过证据,属于 `无关证据`,必须改为未覆盖或补 CDS 平台证据。
- 截图 caption 和图内标签必须写行为断言,不是写模块名。例如正确: `知识库同步：点击同步后同步日志新增成功记录`;错误: `知识库列表：列表可见`。

## 页面优先证据分层（2026-06-20 反哺）

> 用户心智反哺：验收报告首先是给验收用户看的。用户先关心“我在哪个页面看到这个改动生效/失败”，再关心“后台数据为什么这么判断”。内部数据不能压过页面反馈。

- 对所有用户可感知的改动,必须先找页面证据:页面位置、可见状态、按钮状态、错误提示、同步状态、进度条、结果行、详情面板、空状态、toast、或“禁止动作不存在”。
- API、日志、数据库、命令输出只能作为第二证据,用于解释页面结果、证明持久化、证明负面路径或诊断失败。除非该改动明确是内部能力,否则内部数据不得单独支撑通过。
- 报告必须包含「页面优先证据分层」章节或等价表格,列出: `改动断言`、`用户可见页面/状态`、`页面证据`、`内部佐证`、`缺口`、`结论`。
- 如果没有页面证据,必须写成 `无用户可见页面`、`内部能力` 或 `未覆盖`,并说明原因。不能把 API 200、日志存在、数据库有记录包装成视觉验收通过。
- 每个页面截图的说明要回答用户心智问题:用户应该从这张图看懂什么、问题在哪里、为什么这能代表提交结果。只写“接口返回”“数据存在”不合格。
- 高级他测顺序固定为:先按用户路径操作并观察页面反馈,再用内部证据反证或解释,最后质疑“这个页面反馈是否真的由该 commit 导致”。不能倒过来先找数据再找一个附近页面贴图。

## 每日验收深度门禁（2026-06-20 反哺）

> 事故反哺：2026-06-18 有 103 条 commit，上一版只用 6 张入口/API 图就写成 L2 每日验收，用户质疑“才六个图，不像深入功能验收”。复跑后发现 MCP POST 授权边界、短视频非法 URL 入队等入口冒烟抓不到的问题。结论：**广度冒烟不是深度验收**。

- 每日/昨日验收必须先做「改动规模盘点」：写清目标日期、commit 数、PR 数、模块数、高风险模块数。
- 报告必须显式声明验收深度：`广度冒烟` / `深度验收` / `发布前阻断验收`。不声明时按广度冒烟处理。
- 只有入口可达、页面主体可见、少量 API 200 的报告，只能叫 `广度冒烟`，不能写“深度验收”“深入功能验收”“完整验收通过”。
- 若报告声称 `深度验收` 或 `深度复验`，默认至少需要 12 张有效截图；归档脚本会对每日/昨日深度报告做硬门禁，少于 12 张直接拒收。
- 深度验收的每个高风险模块至少要有 2 个证据点：一个用户路径截图 + 一个结果截图/API/负面路径证据。典型高风险模块包括鉴权、异步任务、文件上传/压缩、外部下载、发布/部署、状态流转、数据恢复。
- 深度验收必须包含负面路径或边界测试。没有负面路径时，只能判“广度冒烟通过”或“有条件通过”，不得判深度通过。
- 如果因成本或安全性不能触发真实流程（如真实生图、外部视频下载、CDS canary、生产写入），必须在报告中标为 `未深测`，不能用入口截图替代。

## 每日验收内容充裕门禁（2026-06-21 演练反哺）

> 演练反哺：每日验收不是“截几张图 + 写一个结论”。用户要判断的是昨天到底做了什么、哪些提交被证明了、哪些只是有条件覆盖、哪些完全没覆盖。报告内容必须充裕到能防遗漏，而不是靠读者补脑。

- 报告必须先讲清“昨天做了什么”：按模块总结新增、修复、优化、文档/规则、环境/部署、未发布状态。不要只写“完成若干改动”。
- 每个高风险或运行态改动必须有落点：`pass`、`conditional`、`fail`、`internal-only`、`non-runtime`、`uncovered` 六选一。没有落点就是遗漏。
- 每个主要表格都要填实质内容：来源 commit/PR、changed files、改动断言、页面位置、预期结果、实际证据、关联性、结论。禁止用 `同上`、`见上文`、`略`、`待补`、`按常规` 代替。
- 报告必须同时回答五个问题：改了什么；用户在哪能感知；怎么触发；预期应该看到什么；这张图或内部证据为什么能证明它。
- 充裕不等于堆字。重复截图、泛泛描述、无关页面、流水账日志不算充裕。只有补足范围、断言、预期、证据、缺口、风险解释的内容才算充裕。
- 如果一天变更很多,允许合并为功能簇,但功能簇内必须保留 commit 列表和覆盖结论。合并是为了理解,不是为了隐藏没测项。
- 报告结尾必须有“总缺口账本”：列出未深测、弱相关、内部证据、环境抖动、需要后续专测的项。没有缺口账本的有条件通过报告不合格。
- 归档前自问:一个没参与开发的人只看这篇报告,能否复述昨天的主要变更、哪些被证明、哪些没被证明、为什么总 Verdict 不是更高或更低。不能复述就继续补内容。

## 取证选材与标注（重点,2026-05-31 强化）

> 用户反复反馈的体验缺陷:截了一堆图,但读者**不知道这部分在验证什么**。本节是硬要求。

### A. 框选重要的东西(不是全截,也不是只截一张)

- **框选**:覆盖本次验收里**所有"用户能直接看到的重要变化"**——核心页面、关键交互、新增入口、状态切换。不要只截一个首页就交差。
- **但只截重要的**:跳过纯后端 / 纯配置 / 无视觉变化的改动;不为凑数截无关页面。
- **判定**:"用户会因为这个变化而感知到差异" → 必须有图;"用户看不见" → 不截,但在报告里用文字说明已验证。
- 多功能验收时,**每个重要功能至少一张结果图**,关键交互补"点这里"步骤图(stepClick)。

### B. 每张截图必须标注"验证了什么"(caption 硬约束)

- caption 格式:**`{功能/区域}：{这张图证明了什么}`**。
- 正确:`AI 大事双栏布局：feed 居左 + 右侧栏填充,宽屏无大片留白`
- 正确:`网页托管评论：右下角浮动按钮点击后滑出评论抽屉`
- 错误:`首页截图` / `AI 大事` / `截图1`(只说在哪/是什么,不说验证了什么——读者只能靠猜)
- **harness 的 `shot/stepShot/stepClick` 的 caption 参数即此用途**;`writeManifest` 落进 manifest 的 `caption` 字段会原样进报告图注。**caption 为空或只有功能名 → 视为证据不合格**(准入校验 §3.5 已对空 caption 拒收,本节进一步要求"必须含验证点")。

### B2. 框选重点是硬要求（caption 文字在图外,读者不知道看哪——必须在图上画框）

> 历史教训(2026-06-04):给用户发"证据图"、"手机端改造前后"等截图,只配了文字 caption、**没在图上框出重点**,用户反馈「我甚至都不知道你指的是哪些」。caption 在图的外面,读者的眼睛在图里面——**文字说不清"看这里"**。

- **任何"指向具体元素/区域/差异/问题"的截图,必须在图上画标记 + 一句标签**(harness `box(page,locator,label,{shape})` / `stepShot(...,highlight,{shape})` / `stepClick(...)`)。标记 + 序号/短标签直接压在目标上,读者一眼定位。
- **形状选择(2026-06-05 起)**:指向**单个**按钮/输入框/图标/pill → 用**圈圈** `shape:'circle'`(更友好、更像人手画的指向,治"看到一个单独页面就懵逼");框**一片区域/差异/列表** → 用**方框**(默认)。`annotate.mjs` 的 box 项加 `"shape":"circle"`,harness `box(page,loc,label,{shape:'circle'})`,`stepClick` 默认已是圈圈。
- **标签必须答"看这里:是什么"**:caption/标签写成「看这里:右上角『本页教程』入口」这种**指路 + 命名**句式,而不是只写功能名。读者顺着圈 + 这句话就懂这张图在证明什么,不用猜。
- **同一张图里有多个有先后关系的操作/状态时,必须用数字标顺序**:标签写成 `① 生成连接串`、`② 复制连接串`、`③ 粘贴对端连接串`、`④ 添加按钮禁用/可点` 这种形式。禁止只写「串」「复制」「禁用」「表单」这类无序语义标签,除非这些重点确实可以无序阅读。判定标准:读者如果需要知道"先做哪个、后看哪个",就必须编号。
- **唯一豁免**:纯"整体观感/全局布局"的 overview 图(就是要看整体,无单一重点)可不画标记,但 caption 要写明"看整体布局,无单点"。
- **本规则不限于全流程验收 driver**——**任何发给用户的截图都适用**,包括:临时诊断、方案评估、critique、改造前后对比。哪怕只是一次性 `page.screenshot()`,也要**先注入带标签的红框再截**。**最省事的做法:直接用 `scripts/annotate.mjs`** —— 一条命令对任意页面按 selector/坐标画框 + 标签再截图,不用写整个 driver(支持 `--login` 表单登录、`--mobile` 手机视口、`--click` 截图前先点开某元素)。也可 `import { box, clearBoxes } from harness.mjs` 脱离 driver 单独用。
- **多个重点画多个框 + 编号**(①②③),标签用不同颜色区分维度(如 红=错误/问题、橙=冗余、蓝=缺失)。框要框在"我这句话说的那个东西"上,不能泛框一大片。**同页多步骤截图没有数字顺序 = 不合格**,需要返工截图或把该图拆成多张 stepClick/stepShot。
- 判定:**把这张图单独发给一个没听我解释的人,他能不能 3 秒看出"重点在哪、这框说的是什么"?** 不能 → 没框/框错,返工。
- **这是硬门禁,不是自觉(2026-06-05 起,治"技能这么多次给没标注的截图")**:`harness.shot()` 在截图瞬间自动探测页面有没有标记(`.__acc_box`),把 `annotated` 落进 `manifest.json`;`archive_report.py` 准入对 `annotated:false && !overview` 的图**直接拒收**——**没画框/圈的指向性证据图,报告归档不进去**。所以:
  - 用 `stepClick` / `stepShot(...,highlight)` / 截图前先 `box(page,loc,label,{shape})` —— 它们都会留下 `.__acc_box`,自动算"已标注"。
  - **唯一豁免**:纯整体观感/全局布局图,`shot(page,out,name,cap,{overview:true})` 显式标 overview,门禁放行(对应"当然没必要的除外")。
  - 直接 `page.screenshot()` 不进 manifest、不受门禁保护,**禁止**用它出证据图;一次性发图也走 `annotate.mjs`(它本就带框/圈)。

### C. 报告里图文对应,不留疑问

- 每张图在正文里**紧跟它所验证的那段文字**(ZZ 照做风:文字在上、图在下、`{{IMG:<name>}}` 占位)。
- 某个重要功能**没截到图**时,必须显式写「本功能未取截图,原因:……」,不留空白让读者怀疑是漏测还是没做。

## 自动选模板（AI 自决，告知用户；歧义才问）

技能本身按规则自动决定用哪套模板（v2.1 起），**不让用户每次都选**。AI 调用本技能时按下表判定，并在第一句话告诉用户「本次用 X 模板，理由 Y」：

| 信号 | 选模板 | 理由 |
|---|---|---|
| 单一功能/单页/单模块；流程线性（点A→点B→看结果） | **ZZ 照做风**（默认） | 步骤化叙事让"同岗位照做能复现"，对线性交互最直观 |
| L0 / L1 档位；用户提了具体场景化诉求 | **ZZ 照做风** | 步骤序号天然映射诉求条目，便于一一对应 |
| 跨模块/跨端（后端+前端+桌面）；L2 档位 | **九段集中证据** | DoD/自测路径/硬约束/缺陷分段更适合复杂证据 |
| 安全/性能/合规重点；用例非线性需要 ISO 25010 维度分类 | **九段集中证据** | 用例表带 Phase + 维度列，集中证据段适合截图+日志混排 |
| 单纯回归测试，不引入新行为 | **九段精简版**（删 5.5 节，保留其他） | 用户没提新需求 → 不需要"需求一一对应表" |
| 信号矛盾（如 L2 但单页、或多端但单一诉求） | **问用户**（仅此场景才问） | 用 AskUserQuestion 给两个选项 + 推荐项 |

**实操**：AI 在 driver 写完截图后、归档前，按上表挑模板，并在交付消息里第一段写：

> 本次验收用「ZZ 照做风」模板。理由：单页交互 + 用户提了 10 条线性诉求，步骤号天然对齐诉求表。

歧义场景才走 AskUserQuestion。**禁止"凭感觉随便选"或"两套都跑一遍"**。

## 工作流(四步)

1. **定标准与档位 + 选模板**:读 `reference/standard-v2.md`,按改动定 L0/L1/L2(下限见 §3);按上表「自动选模板」决定 zz-report.md / report-template.md(歧义才问用户)。
2. **写 driver 取证**:用 `scripts/harness.mjs` 的 helper 写本次验收的真人路径脚本。基础 helper:`launch/login/gotoByClick/click/type/setTheme/shot`。**ZZ 照做 helper(画框 + 步骤序号,默认用)**:`stepClick(page,outDir,N,locator,name,caption)` 在点击目标上画红框 + 标序号 → 截"点这里"图 → 清框 → 真点击;`stepShot(page,outDir,N,name,caption,highlight?)` 截结果图并框住变化处;`box/clearBoxes` 手动画框。跨用户前置(如造分享链)走 API。结束 `writeManifest(outDir, {verdict,target,themeSupport,timing})`。
   - **v1.0 自动捕获(默认开,零配置)**:`launch()` 已默认挂 `attachAutoCapture`——取证全程自动收集 console.error / 同源 4xx-5xx / 未捕获异常(标准 §5.3),P0 级(未捕获异常 + 5xx)自动折叠进截图 warnings → 准入直接拒收。这是"人眼扫静态图永远漏"的维度,机器替你盯。
   - **v1.0 双主题**:先 `detectThemeSupport(page,cfg)` 探测本页是否真支持 light(标准 §5.4);`supportsLight=true` 才双主题各一张,dark-only 页单图 + 注明不计 fail。别交两张一模一样的暗图。
   - **v1.0 机读产物**:`writeManifest` 同时写 `result.json`(verdict/autoFindings/themeSupport/timing),供下游 Agent 直接消费。
   - **v1.0 过程视频(可选)**:`launch(cfg,{recordVideoDir:OUT})` + 收尾 `finalizeVideo(page,ctx,OUT)`,产 `walkthrough.webm` 作**本地证据,不进知识库正文**(沿用用户决定,见 `debt.visual-agent.acceptance-skill.md`)。
   运行:`PWPATH=$(npm root -g)/playwright node <driver>.mjs`(无 playwright 先 `npm i -g playwright && npx playwright install chromium`)。
3. **读图核对（全量,不许抽查)**:manifest 里**每一张**截图都用 Read 工具读回,肉眼级核对 caption 与图内容一致(这套抓到过"匿名未登录""按钮没渲染"等真 bug)。图文不符 → 修 driver 重拍,**禁止改 caption 迁就错图**。pass 用例必须连图、图必须独立可证 claim(反例:声称"下拉含 8 选项"但图里下拉收起——先 `select.size=N` 展开再截)、关键词断言不得同义反复(排除自己输入的消息,锚定产物区域)。详见 standard §3.6 证据链连线,准入第 8 项机检兜底。据此填**自动选定的模板**得出 Verdict。两套模板共享同一速览卡(H1 + Verdict + 一句话结论 + 元信息表) + 同一结尾(meta 注释);中间章节按所选风格走。
   - **每日验收报告结构(2026-06-18 固化,2026-06-20 修订)**:每日/昨日验收类报告必须先给类似周报的「昨日工作总结」,说明昨天做了什么、按模块覆盖了哪些内容、哪些没覆盖;紧接「PR/commit 到结果映射」「改动断言到证据表」「改动断言表」「影响面矩阵」「融合测试设计」「证明力矩阵」「覆盖缺口」和「覆盖矩阵」,再按大章节逐页验收。正文**不放目录**,避免目录占位替代证据链。页面章节顺序建议:总结 → PR/commit 到结果映射 → 改动断言到证据表 → 改动断言表 → 影响面矩阵 → 融合测试设计 → 证明力矩阵 → 覆盖缺口 → 覆盖矩阵 → 验收地址 → DoD/自测 → 需求一一对应 → 用例表 → 截图回读检查 → 页面验收章节 → 重试记录 → 缺陷清单 → 总结论。不得直接堆截图。
   - **每日验收必须写明深度预算(2026-06-20 修订)**:每日/昨日验收类报告必须在「覆盖矩阵」前写「改动规模与深度预算」,包含 commit 数、PR 数、模块数、高风险模块、计划证据数、实际证据数。数据来源优先用 `daily_scope.py` 的 JSON。证据不足时顶部结论必须降级为 `广度冒烟` 或 `不通过`,不能把少量入口截图包装成深度验收。
   - **每日验收必须内容充裕(2026-06-21 修订)**:每日/昨日验收类报告不能只有截图清单和短结论。必须充分展开昨日工作总结、commit/PR 映射、改动断言到证据、页面优先分层、覆盖缺口、缺陷清单和总缺口账本。复杂日报里出现 `同上`、`见上文`、`略`、`待补`、`按常规` 等空泛填充,视为半成品。
   - **每日验收证据引用必须可点击(2026-07-01 修订)**:`PR/commit 到结果映射`、`改动断言到证据表`、`覆盖矩阵`、`需求一一对应表`、`验收用例`、`缺陷清单`、`截图回读检查` 等表格里的证据列,不要只写裸 `图01`。优先写完整截图名锚点,例如 `{{IMG:01-login-home}}` 对应 `[图01](#fig-01-login-home)`；多图写 `[图01](#fig-01-login-home)、[图02](#fig-02-voc)`。`archive_report.py` 会给每个 `{{IMG:<name>}}` 截图自动注入 `fig-<name>` 锚点,并把唯一编号的裸 `图XX` 或旧式 `#fig-XX` 规范化为完整锚点；同编号多图时必须写完整锚点,避免跳错证据。
   - **每日验收必须内置标记法则与验收标准**:每日/昨日验收报告必须有「标记法则与验收标准」章节,把颜色含义、严重级、测试规则、所用验收标准写清楚,让读者不用回看技能文档也知道图上的框是什么意思、为什么最终判通过/不通过。
   - **颜色标记统一**:红色=P0 阻断缺陷(空白/崩溃/核心不可用),橙色=P1/P2 中高风险或体验干扰(遮挡/错位/可用但不稳),蓝色=环境/路径/数据可达性说明(顶栏可见/路由可达/接口返回),绿色=通过证据(主体可见/关键区域正常)。同一张图里同时存在「可达」和「失败」时必须拆成不同颜色标记,不能全用一种颜色。
   - **问题标记必须可定位**:问题区域必须框到具体范围,标签写清严重级 + 现象,如 `P0: 正文区域空白`;禁止只写「有问题」「异常」「看这里」。通过标记也要写清通过了什么,如 `通过: CDS Agent 主体可见`;禁止只写「正常」。
   - **问题定位自测必须入报告**:日报、争议复测、失败报告必须加「问题定位自测」或等价段落。每条 P0/P1/P2 视觉问题要回答:具体页面区域、异常物是什么、挡住或破坏了什么、用户为什么受影响、图内哪个框/圈证明它。回答不出来就不能把该问题写成有效缺陷。
   - **规范一致性自测必须入报告**:日报、争议复测、失败报告必须加「规范一致性自测」或等价段落,核对本轮实际流程是否真的使用 `acceptance-test-design -> acceptance-scenario-orchestrator -> create-visual-test-to-kb`,深度标签是否与证据一致,规范引用是否真正改变了测试动作而不是装饰性引用。
   - **截图回读必须显式写进报告**:截图后不仅要自己看一眼,还要在报告里增加「截图回读检查」表,逐图记录是否截歪、是否加载完成、是否空白、问题是否入镜。发现缓慢加载/半截/空白但不是目标缺陷时,必须重拍;如果空白正是目标缺陷,要在图上框出空白区域并在回读表中说明。
4. **归档(默认进 CDS 验收中心,职责分离)**:`python3 scripts/archive_report.py --config acceptance.config.json --target "<目标>" --module "<模块>" --feature "<功能>" --type "<新增功能|优化|修复>" --verdict <pass|conditional|fail> --tier <L0|L1|L2> --report-md <正文.md> --manifest <outDir>/manifest.json [--branch --commit --pr]`。
   - **归属唯一:CDS**。验收能力归 CDS(平台自带、按项目分类、证据链内置);技能**不再分流到 MAP 知识库**——MAP 等系统通过知识库开放协议(peer-sync)从 CDS 拉取展示。`report.mode` 缺省=`cds`;`local` 为离线兜底;`doc-store` 仅向后兼容(需 config 显式保留)。详见 `../cds/reference/acceptance-reports.md`。
   - **交互 HTML 默认**:正文保留 `{{IMG:name}}`/`{{EVIDENCE}}` 结构作为 Markdown 写作源,归档脚本默认转成 `format=html` 交互报告（证据导航/表格筛选/章节折叠/图号跳转）。截图**内联为 data-URI** 后由 CDS 入库抽成 report assets。报告自包含、单份 < 10MB(超了减截图或改用 `cds/cli/acceptance` 的 JPEG 压图取证管线)。CDS 鉴权走 env `CDS_HOST` + (`CDS_PROJECT_KEY` 或 `AI_ACCESS_KEY`)。仅在下游明确要求 Markdown 时把 config `report.format` 改为 `md`。
   - **按项目 + 文件夹归类**:报告永远带 projectId(config.report.cdsProjectId > env CDS_PROJECT_ID > config.project);`config.report.cdsFolder` 设了就按名 find-or-create 项目级文件夹。`--verdict/--tier/--branch/--commit/--pr` 作为元数据 + E1 部署上下文 stamp 进报告(看板/跨系统/PR 回写都靠这些)。
   - **命名固定结构**(用户定):标题 = `项目 · 模块 · 功能 · 操作方式 · 验收报告`(`--module/--feature/--type` 拼装,空段自动跳过)。**状态(通过/不通过)不进标题——走 verdict 元数据徽章**,不靠改名表达状态。
   - **必给地址**:收尾必打印「验收归档完成 · CDS 验收中心」块 + `/reports?project=&folder=&report=` 直达深链——每次归档都有一个可达地址交付,绝不静默。
5. **归档后自查能否打开(强制,创建≠能看)**:拿到可达链接后**必须**跑 `PWPATH=$(npm root -g)/playwright node scripts/verify-open.mjs <url> "<标题里必现的一段>" <最少图片数>`。它 headless 打开真页面断言报告渲染(标题 + 正文 + 截图);默认**最多尝试 3 次**(首试 + 2 次重试),吸收 CDS/Cloudflare/预览网关的偶发抖动和图片慢加载。CDS 直达深链是登录态(headless 需带 CDS 会话或用 `cds/cli/acceptance` proxyroute harness 打开);**匿名分享链 `/r/<token>`(E6)无需登录,headless 可直接断言——首选**。**重试不能抹掉首试失败**:若第 1 次失败、第 2/3 次通过,报告必须记录「第一次结果 / 重试动作 / 最终通过次数 / 最终判定」,并标为链路风险;**exit 0 = 真能看**才算交付完成,**exit 2 = 空白/打不开/截图缺失 → 重新推送验收**(重跑第 4 步,生成新 report_id)。杜绝"建了条目但点开空白"流到用户手里。

## 端到端示例(照抄即可)

`scripts/example-driver.mjs` 是可直接改的取证脚本骨架。完整一轮:

```bash
SKILL=.claude/skills/create-visual-test-to-kb
export PWPATH=$(npm root -g)/playwright
export MAP_AI_USER=inernoro MAP_ACCEPT_PASS='***' AI_ACCESS_KEY='***'

# 1. 复制示例 driver,按本次验收改 gotoByClick/click/shot 步骤
cp $SKILL/scripts/example-driver.mjs /tmp/my-driver.mjs
#   编辑 /tmp/my-driver.mjs:登录 → gotoByClick(目标菜单) → 操作 → shot(...)

# 2. 取证(产出 /tmp/acc_shots/*.png + manifest.json)
node /tmp/my-driver.mjs "$(python3 $SKILL/../cds/cli/cdscli.py --human preview-url)"

# 3. 读图核对(用 Read 工具逐张看),据 templates/report-template.md 写 /tmp/report_body.md
#    正文里用 {{EVIDENCE}} 占位,脚本自动替换为内联截图

# 4. 归档(默认 cds 验收中心;无 CDS/离线改 config.report.mode=local)
python3 $SKILL/scripts/archive_report.py --config $SKILL/acceptance.config.json \
  --target "你的验收目标" --verdict pass --tier L2 \
  --report-md /tmp/report_body.md --manifest /tmp/acc_shots/manifest.json \
  --branch "$(git branch --show-current)" --commit "$(git rev-parse --short HEAD)"
```

## 交付(CDS 验收中心,职责分离)

> **验收能力归 CDS,MAP 只消费**(用户 2026-06-25 定调):报告永远入 CDS 验收中心(平台自带、按项目分类、证据链内置)。MAP 等系统通过知识库开放协议(peer-sync)从 CDS 拉取展示,**无需各自再建「验收中心知识库」**。技能不再做 MAP/CDS 分流判断。

- **① CDS 直达深链(默认交付)**:`/reports?project=&folder=&report=`(归档脚本输出)。登录态可达,左侧文件夹高亮 + 右侧报告(正文 + 内联截图)渲染。按项目 + 文件夹归类,带 verdict 徽章 + 部署上下文。
- **② CDS 匿名分享链(对外/未登录)**:`/r/<token>`(E6,只读、可撤销)。给未登录第三方看不必退回 MAP;headless `verify-open` 也用它直接断言。
- **③ MAP 知识库(跨系统展示)**:MAP 管理员在「同步中心」配对 CDS 节点 → 选 `acceptance-report` → pull,CDS 报告落成 MAP 知识库(可搜索/打标签/关联)。增量靠 contentHash 去重,MAP 核心零改动。
- **聊天内直给**:截图发给用户(authed 渲染图)是最稳的"立即可读"方式,不依赖任何链接。

> 历史教训:(2026-05-26)曾把 share 链接当"点开即看"交付却空白——根因是正文没落库。交付前必须自己用无头浏览器(`verify-open.mjs`)走一遍目标查看路径,确认报告正文 + 截图真的渲染,exit 0 才算交付完成。

## 按需文件(渐进式披露)

| 文件 | 内容 | 何时读 |
|------|------|--------|
| `reference/standard-v2.md` | 完整标准:命名/档位/浏览器操作/截图/报告结构/Verdict 规则/国际标准对照 | **必读**,动手前 |
| `../acceptance-scenario-orchestrator/SKILL.md` | 每日/PR/commit/未发布分支等复杂场景的范围编排与证据契约 | 验收目标不只是单页单流程时 |
| `../acceptance-test-design/scripts/daily_scope.py` | 每日范围盘点:目标日期 commit、模块、高风险标签、open PR、未发布分支;输出 JSON/Markdown | 每日/昨日自动验收第一步 |
| `templates/zz-report.md` | **默认** ZZ 照做风骨架(全大标题 + 一句话一步 + `{{IMG:}}` 逐步配图) | 写报告时(首选) |
| `templates/report-template.md` | 旧版九段骨架(速览卡 + 九段 + 用例表 + `{{EVIDENCE}}` 集中证据) | 要集中证据段时 |
| `scripts/harness.mjs` | 模拟人类浏览器 helper(点击导航/截图/主题 + ZZ 画框 stepClick/stepShot/box) | 写 driver 时 |
| `scripts/annotate.mjs` | 通用「框选重点」工具:一条命令对任意页面按 selector/坐标画框+标签再截图(--login/--mobile/--click) | 发任何指向性截图前(§B2 硬要求) |
| `scripts/archive_report.py` | 配置驱动归档(默认 cds:Markdown 写作源 → 交互 HTML → POST /api/reports,按项目+文件夹归类,带 verdict/部署上下文;local 离线兜底;doc-store 向后兼容) | 归档时 |
| `scripts/verify-open.mjs` | 归档后自查:headless 打开可达链接断言报告渲染(标题+正文+截图);空/打不开 exit 2 | 归档后(强制) |
| `../cds/reference/acceptance-reports.md` | CDS 验收中心:报告/文件夹 API、cdscli report 命令、取证管线、深链格式、10MB/份压图注意 | 归档到 CDS 时 |
| `acceptance.config.json` | 项目配置(预览域名/登录/CDS 项目与文件夹/截图);跨仓库改这个 | 接新仓库时 |

## 回读批注闭环(用户批注 → 智能体复测;仅 doc-store 向后兼容路径)

> 适用范围:**仅当 config 显式 `report.mode=doc-store`**(旧 MAP 知识库归档)。默认 CDS 路径的报告回读走 CDS(在报告页查看/评论),不经下面的知识库批注接口。`scripts/read_comments.py` 仅服务 doc-store 路径。

知识库与本技能是双向的:doc-store 模式把验收报告**写**进知识库;用户在那篇报告里**划词/框选文字批注**(或对整篇评论)留下反馈,验收智能体再把这些批注**读**回来做下一轮复测。最简实现是按需轮询(不是监听):

```bash
# 归档后,归档脚本会输出 storeId/entryId;隔段时间或被要求复测时拉一次最近批注
python3 $SKILL/scripts/read_comments.py --config $SKILL/acceptance.config.json \
  --store "验收报告" --entry <报告条目 entryId> --since <上次拉取时间ISO>
```

- 鉴权复用归档同一把 `MAP_DOC_STORE_KEY`(`document-store:write` 写蕴含读,可调读接口);后端 `GET /stores/{storeId}/recent-comments` 已做读权限校验,只返回该 key 可读库的批注。
- 输出末尾 `COMMENTS_JSON: {...}` 供智能体解析:每条含 `entryTitle / selectedText(被批注原文) / content / authorDisplayName / createdAt / isWholeDocument / status`。智能体据此定位"用户对哪段不满意",针对性复测/修复,再走第 4 步重新归档(新 report_id)。
- `--since` 做增量:只取上次拉取后的新批注,避免重复处理。监听式(webhook/SSE 主动推送)是后续增强,先用这条拉取路径跑通。

## 跨仓库复用

整个技能项目无关,耦合点全在 `acceptance.config.json`:预览域名命令、登录选择器与 env、文档空间 API base、报告库名、截图参数。别的仓库装本技能 + 改配置即用;`report.mode=local` 时退化为写 `/tmp/map-acceptance-local` 这类仓库外临时目录,不依赖文档空间。

## 与既有技能的关系

- `acceptance-checklist`(/uat):执行**前**生成真人逐步打勾清单。本技能:执行**后**沉淀结果报告。互补。
- `bridge`:操作"用户当前真实浏览器"(交互/演示)。本技能取证走**本地无头浏览器**,二者不混用。

## 合规

全中文;禁 emoji(CLAUDE §0);截图通过知识库传输共享协议一次性提交,最终正文只能保留正式 HTTPS 图链,不允许 `data:image`;报告不可变(重测出新 report_id);预览地址走 cdscli 禁手拼(规则 #11)。

## 报告图片与资产存储（2026-06-22）

验收报告/知识库正文的图片走后端统一资产存储 `IAssetStorage`，由 `ASSETS_PROVIDER` 决定后端，**SHA256 内容去重**：

| 后端 | ASSETS_PROVIDER | 必需 env | 用途 |
|------|-----------------|----------|------|
| 本地 | `local`（或未配凭据时自动兜底） | `ASSETS_LOCAL_DIR`（可选，默认 `{ContentRoot}/data/assets`） | 开发/预览/占位——无云凭据也能存图 |
| Cloudflare R2 | `cloudflareR2` | `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET`（+ 可选 `R2_PUBLIC_BASE_URL` `R2_PREFIX` `R2_ENDPOINT`） | 生产云端 |
| 腾讯云 COS | `tencentCos` | `TENCENT_COS_BUCKET` `TENCENT_COS_REGION` `TENCENT_COS_SECRET_ID` `TENCENT_COS_SECRET_KEY` | 生产云端 |

`ASSETS_PROVIDER` 未显式设置时按 **auto** 选择：有 COS 凭据→COS；否则有 R2 凭据→R2；都没有→**local 占位**（不再像旧逻辑那样直接抛异常，避免 CDS 预览等无凭据实例传图失败）。

### 两种传图入口（接口已规范）
1. **随正文一次性归档**（本技能默认）：Markdown 用 `{{IMG:name}}` 占位 + `assets[]` 传 base64，或正文直接内嵌 `data:image` / HTML `<img src="data:...">`。`PUT /api/document-store/entries/{id}/content` 的归一化器会抽取→存储→改写为正式 URL（正文不留 `data:image`）。
2. **单独上传一张图片**（新增）：`POST /api/document-store/stores/{storeId}/images`（multipart `file`），返回 `{ url, sha256, mime, sizeBytes }`，供正文按 URL 引用。解决"上传 HTML 报告内嵌图存不住、又没有单独传图入口"。
