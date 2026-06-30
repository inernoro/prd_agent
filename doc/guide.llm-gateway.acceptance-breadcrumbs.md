# guide.llm-gateway.acceptance-breadcrumbs

> 类型: guide（How-to — 怎么操作）| 状态: 开发中 | 更新: 2026-06-30
> 关联: `doc/spec.llm-gateway-test-matrix.md`（测什么 SSOT）、`doc/report.gw-test-matrix.md`（全量可见报告）、
> `doc/design.llm-gateway-physical-isolation.md`、`doc/debt.llm-gateway-isolation.md`、
> `.claude/rules/closed-loop-acceptance.md`（验收必须闭环）、`.claude/skills/create-visual-test-to-kb/`（取证流水线）

## 1. 管理摘要 + 怎么用

「LLM 网关从 MAP 剥离」改动面横跨多屏：管理后台的 LLM 日志观测（生命周期 chip / 黑洞记录 / 应用聚合 /
COS 占位还原 / 生图显示）、模型池健康告警、独立观测前端 prd-llmgw-web、CDS 拓扑命名子域 host 边、以及
serving 影子比对读端点。本文档把每一屏拆成**自动化工具（Playwright 无头浏览器）可直接消费的「面包屑清单」**：
逐屏给出「导航点击路径 → 截图点 → 预期」三元组，外加测试覆盖矩阵摘要、例外/边界清单、压测计划。

### 给自动化工具的约定（每条面包屑的契约）

每条验收项 = 三段：

1. **面包屑（有序点击步骤）**：从「登录后首页」开始，逐步 `click` 进入目标屏。
   - **禁止地址栏直达**：必须模拟真实用户路径（点菜单/按钮/tab），对齐 create-visual-test-to-kb 取证原则。
   - 锚点优先级：真实可见文案 > `data-tour-id` / `data-*` > 稳定 DOM 结构。本文给的都是当前代码里**真实存在**的文案/选择器。
2. **截图点列表**：每个截图前必须 `waitForSelector` 命中**产物本身**（真实日志行/真实正文/真实图片/真实 JSON），
   不是 spinner、不是「加载中…」、不是「正在聚合…」。
   - **验收必须闭环**（`closed-loop-acceptance.md`）：生成/还原/比对类要截到「产物真的出现」。超时只能记录超时现象，
     不得在 caption 写「已完成」。
3. **预期（双主题）**：暗色 + 亮色各截一张（项目惯例）。主题切换方式见各面备注。预期写明「断言哪个文案/元素存在」。

### 路由与权限速查（真实来源：`prd-admin/src/app/navRegistry.tsx`）

| 面 | 应用 | 路由 | 权限 | 菜单文案 | 来源文件 |
|----|------|------|------|----------|----------|
| A | prd-admin | `/logs` | `logs.read` | 请求日志（短标签「日志」） | navRegistry.tsx L657-667 |
| B | prd-admin | `/mds`（`?tab=pools`） | `mds.read` | 模型中心（短标签「模型」） | navRegistry.tsx L765-777 |
| C | prd-llmgw-web | `/login` → `/` | 独立账号体系（非 prd-admin 权限） | LLM 网关观测台 | prd-llmgw-web/src/App.tsx |
| D | cds/web | `/`（BranchTopologyPage） | CDS 鉴权 | 分支拓扑 | cds/web/src/pages/BranchTopologyPage.tsx |
| E | serving API | `GET /gw/v1/shadow-comparisons` | `X-Gateway-Key`（M2M） | 影子比对读端点 | prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs L170-192 |

> 入口待确认提示：prd-llmgw-web（面 C）是**完全独立部署**的 mini-app（自带路由 + 账号，端口 8100，独立
> Dockerfile/nginx），**未注册进 prd-admin 导航**，因此其访问入口取决于部署后的独立域名，见面 C 备注。
> 面 D 的 `<slug>-llmgw` host 边在 CDS 前端代码里**没有硬编码 llmgw 标签**（拓扑按 branch 配置渲染通用
> service/host 节点），该边是否出现取决于该分支是否实际部署了 serving 容器，见面 D 备注。

---

## 2. 测试覆盖矩阵摘要（A/B/C/D 四层 + shadow）

事实来源：`doc/spec.llm-gateway-test-matrix.md`（设计 SSOT）+ `doc/report.gw-test-matrix.md`（约 282 行全量报告，
`scripts/gen-gw-matrix-report.py` 自动生成）。本节只给摘要，不复制全文。

| 层 | 测什么 | 跑在哪 | CI 测试类 | 规模 |
|----|--------|--------|-----------|------|
| A 解析/调度 | 153 个 appCallerCode 真实解析到正确 model/档位/协议 | CI 单元（golden，反射，无 Mongo） | `GwResolutionMatrixTests` + golden 套件 | 153 入口 |
| B 协议保真 | think 位置 / 工具调用归一 / token-cache / 图片三格式还原 / 流式 | CI 单元（纯函数喂 canned payload） | `GatewayProtocolFidelityTests`（读 `protocol-cells.json`） | 91 cell |
| C 跨进程传输 | SSE 逐块 / 上游 500/超时/重置/畸形SSE/空响应 → 归一失败 / 并发 | CI 单元（真 Kestrel loopback + stub gateway） | `CrossProcessServingSelfTest` + `CrossProcessServingErrorLoadTests`（读 `transport-cells.json`） | 18 cell |
| D 真机 | 全 153 resolve + 抽样真打 + 真生图 + 多轮 | CDS 起来后脚本 | `scripts/gw-smoke.py` | 待 CDS 跑 |
| shadow 影子比对 | inproc（权威）vs http 网关逐字段一致性（翻 http 前的去黑盒证据） | serving 进程 + 共享 Mongo | `LlmShadowComparison` 落 `llmshadow_comparisons`，读端点 `/gw/v1/shadow-comparisons` | resolve 全量 + send 采样 |

- 解析档位分布（report §1.2）：DedicatedPool 105 / DefaultPool 41 / NotFound 7（黑洞，预期内）。
- canary 原则：每层至少一个「必败」用例 + 元断言「执行器确实标 FAIL」，证明用例不是空跑（见 spec §canary）。
- 维度 MECE（spec §维度矩阵 D1-D14）：入口 / 流式 / 调度档位 / 协议 / think 位置 / 工具调用 / token-cache /
  图片 / 上下文 / 环境 / 上游中断 / 负载极速 / 演示桩 / 一平台多请求方式。

---

## 3. 例外 / 边界清单

每条写「怎么触发 + 预期表现」。触发以桩上游 / 坏 URL 模型 / canned payload 为主（真实失败路径），
**不依赖** `ModelTestStub.FailureMode`（当前未接入 serving 路径，见 spec §边界 + `debt.llm-gateway-isolation.md`）。

| # | 边界 | 怎么触发 | 预期表现 |
|---|------|---------|---------|
| 1 | 空响应 | 桩上游对该请求返回 200 但 body 为空 / 0 chunk | 归一为失败（非崩溃），日志 status=failed；C 层 cell 断言 `Success=false` |
| 2 | 超长截断 [TEXT_COS] | 请求/回答正文 >1024 字符，写入 COS 占位 `[TEXT_COS:sha256:charcount]` | 日志详情正文区出现占位标记 + 「还原完整内容」按钮可点；点击后正文逐字可读，徽章变「已还原」 |
| 3 | 畸形 SSE | 桩上游发非法 SSE 帧（缺 `data:` / 半截 JSON / 错乱换行） | 解析健壮不崩，B 层 think 半截标签跨 chunk 缝合；归一为失败或部分内容 + 失败标记 |
| 4 | 缺 [DONE] | 桩 SSE 不发 `[DONE]` 终止符直接断流 | 不无限挂起；按连接结束收尾，status 落 failed/succeeded（取决于是否已收内容），可观测 |
| 5 | 假流式 firstByte 慢 | 上游声明 stream 但 hold reasoning 到末尾才 flush（OpenRouter reasoning 默认不转发） | firstByteAt 远晚于 startedAt；生命周期 chip 停在「已发·等响应」（黄，pulse）后转「接收中」；TTFB 指标偏大（见 `.claude/rules/llm-gateway.md` §1/§2） |
| 6 | 上游 500 | 桩上游错误端点返回 HTTP 500 | 主 canary：断言 `Success=false` 且被记 failed；C 层 transport cell 覆盖 |
| 7 | 超时 | 指向慢/坏 URL 模型，超过超时阈值 | 归一失败（failed/blackhole），不崩；server-authority：客户端断开不取消上游 |
| 8 | 连接重置 | 桩在传输中途 reset 连接 | 解析/传输健壮，标记失败，C 层 cell 覆盖 |
| 9 | 并发串号 | 并发 N 个不同 appCallerCode 同时 resolve | 各请求解析互不串租户/串模型；D12 canary：串号即报 |
| 10 | ApiKey 不过线 | serving 端点不带 / 带错 `X-Gateway-Key` | 除 healthz 外一律拒绝（密钥门，GatewayHttpEndpoints L33-40）；面 E 取证用 |
| 11 | NotFound → 黑洞 | 无匹配池的 appCallerCode（7 个 NotFound 入口之一） | 解析档位 NotFound，落黑洞；若已落库 status=blackhole，生命周期 chip 显示「记录降级」（红） |
| 12 | 中转字段异构 | 同 platform 走 per-pool-item / per-model 不同 protocol 覆盖（D14） | 同 platform 出不同 protocol（openai/claude/exchange），ResolutionReason 记层级；覆盖被忽略即报 |

---

## 4. 压测计划

事实来源：`.claude/rules/llm-gateway.md`（流式陷阱）、`.claude/rules/server-authority.md`（断开不取消 / SSE 心跳 / afterSeq）、
`doc/spec.llm-gateway-test-matrix.md` D12（负载/极速）。

| # | 压测项 | 方法 | 通过判据 |
|---|--------|------|---------|
| 1 | 并发 N（不串号） | 并发发起 N 个不同 appCallerCode 的 resolve/调用（N 取 50/100/200 梯度） | 每个请求解析结果与单发一致，无租户/模型串号；错误率不随并发上升而异常飙升 |
| 2 | inproc vs http 时延对比 | 同一批请求分别走 inproc（权威）与跨进程 http serving，记录 P50/P95/P99 | http 路径额外开销可量化且稳定；shadow 比对 AllMatch（见面 E）；http 不显著拖慢主链路 |
| 3 | keepalive 心跳间隔 | 跑长流式请求，抓 SSE 帧时间戳 | 每 ≤10s 有 keepalive 心跳（server-authority 规则 4），断线可 `afterSeq` 续传 |
| 4 | 断开不取消（server-authority） | 流式进行中主动断开客户端连接，观察服务端 | 上游任务不被取消（CancellationToken.None），run 继续到完成/失败；仅用户主动调取消 API 才中断 |
| 5 | shadow 后台不阻塞主链路 | 开启影子双发，对比开/关 shadow 时主链路 P95 | 影子比对在后台异步落 `llmshadow_comparisons`，主链路返回不被其拖慢 |
| 6 | 流式 firstByte P95 | 大批流式请求记 startedAt→firstByteAt 分布 | 区分「真首字」与「OpenRouter latency」歧义（`llm-gateway.md` §1/§5 三源校验）；假流式模型 P95 偏大但可观测、有心跳兜底 |

---

## 5. 视觉验收面包屑清单（主体，逐 UI 面）

> 通用前置：自动化工具先登录 prd-admin（面 A/B/D 前置）。
> - 打开 prd-admin 登录页 → `waitForSelector('input[placeholder="admin"]')`（USERNAME 字段，LoginPage.tsx L813）
> - 在 USERNAME 输入管理员账号 → 在 PASSWORD 输入密码 → 点「登录」按钮 → `waitForSelector` 命中首页/侧边栏
> - 主题切换：prd-admin 走全局主题切换控件（设置/头部），暗/亮各跑一遍同一面包屑各截一张。

### 面 A：LLM 日志页（列表 → 详情抽屉）

- **路由**：`/logs`（权限 `logs.read`）。来源：navRegistry.tsx L657-667；页面 `prd-admin/src/pages/LlmLogsPage.tsx`。
- **进入面包屑**（从登录后首页）：
  1. 在左侧导航 / 命令面板（Cmd+K）找到「请求日志」（短标签「日志」，icon ScrollText）并 `click`。
     - 若侧栏未直接显示，打开命令面板输入「日志」或「请求日志」→ 选中第一项。
  2. 落到 `/logs`，页面顶层 `waitForSelector` 文案「大模型日志」（页面 TabBar，LlmLogsPage.tsx L1273）。
  3. 确认当前在「大模型日志」tab（默认）；其内层是 OpenRouter 风格视图 `LlmGenerationsView`，
     含子 TabBar：`Generations` / `Upstream Requests` / `Sessions` / `应用` / `Jobs`（LOGS_SUBTABS，llmLogsView.helpers.ts L83-88）。
- **截图点 A1（列表）**：`Generations` 子 tab 下，`waitForSelector` 命中**真实日志行**（表头 Date/Model/Provider/App/...，
  且至少一行数据；非空状态「该时间范围内暂无应用请求」）。
  - 预期（双主题）：表格逐行渲染真实模型名 + Provider + App 列；行内状态徽章可见（成功/失败/进行中）。
- **截图点 A2（生命周期 chip + 详情抽屉）**：在 A1 列表里 `click` 任意一行 → 打开 `GenerationDetailsDrawer`
  （createPortal，GenerationDetailsDrawer.tsx）。`waitForSelector` 命中生命周期 chip。
  - 生命周期 chip 文案集（deriveLifecycle，llmLogsView.helpers.ts L175-189，按状态取一）：
    `已完成`（绿）/ `失败`（红）/ `已取消`（灰）/ `记录降级`（黑洞，红）/ `接收中`（蓝 pulse）/
    `已发·等响应`（黄 pulse，疑似没收首字）/ `发送中`（紫 pulse）。chip title=「请求生命周期：区分已发送未收到 / 接收中 / 已完成」。
  - 预期（双主题）：抽屉内顶部生命周期 chip 颜色 + 文案与该日志 status/firstByteAt 一致；TTFB / 总时长可见（drawer 内 firstByteAt 行）。
- **截图点 A3（黑洞记录）**：在 A1 列表筛选/翻页找到一条 status=blackhole 的记录（NotFound 入口或 StartAsync 失败落库）并打开。
  - 预期（双主题）：生命周期 chip 显示「记录降级」（红，`#fb7185`），区别于「失败」（blackhole = 日志写入失败，调用很可能成功只是未可靠记录，故非「未发出」）。
  - 失败判据：若全表无 blackhole 记录，标注「本环境无黑洞样本，待 D 层 gw-smoke 用坏 URL 模型造一条」，不得伪造。
- **截图点 A4（应用维度聚合视图）**：点子 TabBar「应用」tab → `waitForSelector` 命中聚合表（列：应用 / 类型 / 请求数 /
  成功率 / 失败 / 中位时延，llmLogsView.helpers.ts L212-219）+ 底部「按应用前缀 + 类型聚合 · 共 N 组」（LlmGenerationsView.tsx L387）。
  - 预期（双主题）：每行 = 一个应用前缀 + 类型，成功率低于 80% 橙 / 低于 50% 红；直接回应「按应用看混在一张表的日志」。
- **截图点 A5（COS 占位一键还原）**：打开一条正文含 `[TEXT_COS:` 占位的日志详情（长 prompt/回答）。
  `waitForSelector` 命中「还原完整内容」按钮（GenerationDetailsDrawer.tsx L91，title=「正文含 COS 占位符，点击从对象存储还原完整原文」）。
  1. 截图（还原前）：正文区显示占位标记 `[TEXT_COS:sha256:charcount]`。
  2. `click`「还原完整内容」→ `waitForSelector` 命中「已还原」徽章（绿，L75）且正文逐字可读。
  3. 截图（还原后）：提示词 / 回答完整可读，非占位、非「还原中…」。
  - 预期（双主题）：闭环到「正文真的还原出来」；超时则记「还原超时」P1，不得写「已还原」。
- **截图点 A6（生图 URL 在详情里能显示）**：打开一条 generation（生图）类日志详情。`waitForSelector` 命中「输出生成图片」
  区块（ImageSection，GenerationDetailsDrawer.tsx L334-338）下的真实 `<img>`（COS URL 缩略图，L129）。
  - 预期（双主题）：图片像素真实渲染（object-cover），非 spinner、非裂图；治「返回数据图片无法显示」。
- **双主题**：A1-A6 每个截图点暗/亮各一张。

### 面 B：模型池管理 + 健康 / 告警面板

- **路由**：`/mds?tab=pools`（权限 `mds.read`）。来源：navRegistry.tsx L765-777；
  页面 `prd-admin/src/pages/ModelManageTabsPage.tsx` → `ModelPoolManagePage.tsx`（健康总览 `PoolHealthOverview.tsx`）。
- **进入面包屑**（从登录后首页）：
  1. 左侧导航 / 命令面板找到「模型中心」（短标签「模型」，icon Cpu）并 `click`。
  2. 落到 `/mds`，`waitForSelector` 命中顶层 TabBar（ModelManageTabsPage.tsx L34-39，文案：
     `应用模型池管理` / `模型池管理` / `平台管理` / `模型中继`）。
  3. `click`「模型池管理」tab（key=`pools`）→ `waitForSelector` 命中健康总览标题「健康总览」（PoolHealthOverview.tsx L144）。
- **截图点 B1（健康总览 + 告警）**：`waitForSelector` 命中 `PoolHealthOverview` 主体（非「正在加载模型池健康总览...」spinner）。
  - 两种主态择一截：(a) 有告警 → 告警区出现「死池」/「高 fallback」条目 + 「点击定位」（PoolHealthOverview.tsx L201）；
    (b) 全健康 → 绿条「全部健康：无死池、无高 fallback 告警」（L219）。
  - 预期（双主题）：把静默降级一眼暴露成红色一级告警；fallback 率 ≥20% 橙、≥5% 黄。
- **截图点 B2（池内模型健康状态）**：在池列表 `click` 一个池 → 右侧详情出现「健康 / 不可用」计数（ModelPoolManagePage.tsx L723-732）
  + 每个模型的健康徽章（HEALTH_STATUS_MAP：健康绿 / 不可用红，L58-61）。
  - 预期（双主题）：非健康模型旁出现「点击重置为健康状态」入口（L775）；计数与徽章一致。
- **截图点 B3（告警定位联动）**：若 B1 有告警，`click`「点击定位」→ 列表滚动/高亮到对应池（死池）或按 modelType 过滤（高 fallback）。
  - 预期（双主题）：点击后目标池可见并选中；闭环到「告警能跳到现场」。
- **双主题**：B1-B3 暗/亮各一张。

### 面 C：独立观测前端 prd-llmgw-web（登录 → 日志页）

- **应用**：`prd-llmgw-web`（完全独立 mini-app，端口 8100，独立 Dockerfile/nginx，**未注册进 prd-admin 导航**）。
  来源：`prd-llmgw-web/src/App.tsx`、`pages/LoginPage.tsx`、`pages/LogsPage.tsx`、`README.md`。
- **入口待确认**：该 app 独立部署，访问地址 = 其独立部署域名（非 prd-admin 域名）。自动化执行前先确认部署域名；
  若未部署，标注「面 C 入口待确认 / 独立部署，本轮跳过」，不要编造路由。
- **进入面包屑**（直接打开 prd-llmgw-web 站点根，非 prd-admin）：
  1. 打开站点 → 未鉴权自动重定向到 `/login`（App.tsx RequireAuth）。
     `waitForSelector` 命中标题「LLM 网关观测台」（LoginPage.tsx）+ 副标题「请登录以查看请求日志」。
  2. 在用户名输入框（`input[placeholder="用户名"]`）输入账号 → 密码框（`input[placeholder="密码"][type="password"]`）输入密码。
  3. `click`「登 录」按钮（submitting 时文案「登录中…」）→ 鉴权成功重定向到 `/`（LogsPage）。
- **截图点 C1（登录页）**：`waitForSelector('text=LLM 网关观测台')` + 用户名/密码两个输入框可见。双主题各一张。
- **截图点 C2（日志主页）**：登录后 `waitForSelector` 命中顶部 header「LLM 网关观测台」（LogsPage.tsx）+ 右上当前用户 + 「登出」按钮；
  主体 `LogsView`（4 tab + 表格 + 筛选 + 分页）出现**真实日志行**（非空表）。
  - 预期（双主题）：与 prd-admin 数据形状对齐（对接 `/gw/logs`）；表格逐行渲染，非 spinner。
- **截图点 C3（登出回环）**：`click`「登出」→ 回到 `/login`（session 清空）。预期：再次受 RequireAuth 守卫。
- **双主题**：theme.css 暗色默认 + `[data-theme="light"]` 预留；若该 app 暂无切换控件，标注「亮色待确认」并至少截暗色。

### 面 D：CDS 拓扑图（命名子域 host 边）

- **路由**：CDS web `/`（`BranchTopologyPage`）。来源：`cds/web/src/pages/BranchTopologyPage.tsx`。
- **入口待确认**：CDS 前端**未硬编码 `-llmgw` 标签**（拓扑按 branch 配置渲染通用 service/host 节点与边）。
  `<slug>-llmgw` host 边是否出现，取决于该分支是否实际部署了 serving 容器并配置了对应命名子域。
  自动化执行前先确认目标分支已部署 serving；否则标注「面 D：该分支未部署 serving，命名子域边待出现」，不要编造。
- **进入面包屑**（CDS web 登录后）：
  1. 打开 CDS Dashboard → 选中目标分支卡 → 进入「分支拓扑 / Topology」视图（BranchTopologyPage）。
  2. `waitForSelector` 命中拓扑画布 + 该分支 `previewSlug` 标识（CodePill，BranchTopologyPage.tsx L1259）。
- **截图点 D1（命名子域 host 边）**：在拓扑画布中 `waitForSelector` 命中指向 serving 容器的 host 边 / 节点，
  其 host 形如 `<slug>-llmgw.<preview-domain>`（命名子域），并连向 serving 服务端口节点（L1348「端口 N」）。
  - 预期（双主题）：边/节点指向 serving 容器，host 文案含 `-llmgw` 子域；CDS 右上角主题切换按钮（月亮图标）暗/亮各一张。
  - 失败判据：拓扑里无 `-llmgw` 子域边 → 记「serving 命名子域未在拓扑出现」，附该分支部署状态截图，不判 pass。

### 面 E：shadow 读端点取证（curl 步骤 + 预期 JSON 形状）

- **端点**：`GET /gw/v1/shadow-comparisons`，鉴权头 `X-Gateway-Key`（M2M 共享密钥，非 JWT）。
  来源：`prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs` L170-192；记录模型 `LlmShadowComparison.cs`。
- **取证步骤**（非 UI，Playwright 可用 `request`/`fetch` 或 shell curl）：
  ```bash
  curl -sS "$SERVING_BASE/gw/v1/shadow-comparisons?n=20" \
    -H "X-Gateway-Key: $GATEWAY_KEY"
  ```
  - canary：故意不带 / 带错 `X-Gateway-Key` → 预期被密钥门拒绝（边界清单 #10）。
- **截图点 / 断言 E1（summary 全字段）**：响应 JSON `summary` 必含四字段：
  `total` / `allMatch` / `critical` / `httpFail`（GatewayHttpEndpoints.cs L189）。
  - 预期：`allMatch` 接近 `total`、`critical=0`（无 model/protocol 漂移）= 可放心翻 http 的总判据。
- **截图点 / 断言 E2（recent[] 逐字段）**：`recent[]` 每条为 `LlmShadowComparison`，必含：
  - `Inproc` / `Http`：各为 `ResolveSnapshot`（`Success` / `ActualModel` / `Protocol` / `PlatformType` /
    `ResolutionType` / `ModelGroupId` / `IsFallback`，LlmShadowComparison.cs L66-76）。
  - `Mismatches`：逐字段不一致清单 `[{ Field, Inproc, Http, Severity }]`（为空 = 全一致；
    Severity=critical 即 model/protocol 漂移，L78-86）。
  - 其他可见字段：`Kind`（resolve/send/stream/pools）、`AllMatch`、`HasCritical`、`HttpOk`、`ComparedAt`、`ShadowDurationMs`。
  - 预期：`Inproc.ActualModel === Http.ActualModel` 且 `Inproc.Protocol === Http.Protocol`（无 critical mismatch）。
  - 失败判据：出现 `HasCritical=true` 或 `Mismatches` 含 Severity=critical → 阻断翻 http，记 P0。
- **JSON 形状断言示意**：
  ```json
  {
    "summary": { "total": 0, "allMatch": 0, "critical": 0, "httpFail": 0 },
    "recent": [
      {
        "Kind": "resolve", "AppCallerCode": "...", "ModelType": "chat",
        "Inproc": { "Success": true, "ActualModel": "...", "Protocol": "openai", "ResolutionType": "...", "IsFallback": false },
        "Http":   { "Success": true, "ActualModel": "...", "Protocol": "openai", "ResolutionType": "...", "IsFallback": false },
        "Mismatches": [], "AllMatch": true, "HasCritical": false, "HttpOk": true, "ComparedAt": "..."
      }
    ]
  }
  ```

---

## 6. 自动化执行建议（Playwright）

1. **登录**：面 A/B/D 共用 prd-admin 登录（USERNAME `input[placeholder="admin"]` + PASSWORD + 点「登录」）；
   面 C 走 prd-llmgw-web 独立登录（用户名/密码占位框 + 「登 录」）；面 E 用 `X-Gateway-Key` 直发 HTTP，不走 UI。
2. **按面包屑点击进入**：严格用 `click` 沿菜单/tab/行进入目标屏，**禁止 `page.goto` 地址栏直达**（模拟真实用户路径）。
   命令面板（Cmd+K）输入文案选中是允许的「点击」方式。
3. **waitForSelector 真实产物**：每个截图点先等到**产物本身**出现再截——真实日志行 / 生命周期 chip 文案 /
   还原后正文 / 真实 `<img>` / 聚合表行 / 健康总览主体 / 拓扑 `-llmgw` 边 / JSON summary 字段。
   绝不在 spinner、「加载中…」、「正在聚合…」、「还原中…」状态下截图当产物。
4. **双主题各截一张**：每个截图点切换暗/亮主题各取一张（prd-admin 全局主题控件 / CDS 右上角主题切换按钮 / prd-llmgw-web theme.css）。
5. **断言预期文案 / 元素存在**：截图同时 `expect(locator).toBeVisible()` 断言关键文案（如「记录降级」「已还原」「健康总览」
   「LLM 网关观测台」「点击定位」）或 JSON 字段，让证据可机器校验。
6. **闭环判据**（`closed-loop-acceptance.md`）：还原 / 生图 / 比对类必须截到「产物真的出现」；超时只记录超时现象，
   verdict 降级，不得在 caption 写「已完成 / 已还原 / 已渲染」。
7. **入口待确认项如实标注**：面 C（独立部署域名）、面 D（`-llmgw` 子域是否出现）、面 A3（黑洞样本是否存在）
   若环境不具备，按文中失败判据如实标注「待确认 / 待造样本」，不伪造路由或产物。
