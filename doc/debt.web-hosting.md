# 网页托管 · 债务台账

> **版本**：v1.2 | **日期**：2026-08-21 | **状态**：开发中

**一句话**：网页托管三条线的欠账合成一册：托管本体、评论能力、访问统计取到内网地址。
**谁该读**：接手网页托管的工程师；看访问统计的运营。
**读完能做什么**：按线定位欠账，判断统计数据可信到什么程度。

---

> 本台账由 3 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## 主台账

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 13 |
| in-progress | 0 |
| paid | 0 |


---

## 幻灯片翻页方向兼容垫片（2026-06-03 引入）

`InjectSlideNavCompat()` 在用户上传幻灯片类 HTML 时注入运行时垫片，让只认左右
方向键的 PPT 导出页也能用上下方向键 / 空格 / PageUp-Down / 滚轮 / 触摸翻页。
跨域 iframe 决定了只能从内容内部解决（父页面抓不到 iframe 键盘事件），故随内容下发。

### 零重传直接生效（2026-06-03，存量回填）

用户要求：不能让大家重新上传才生效，要对**存量 PPT 直接生效**。

- **否决「访问时后端代理注入」**：托管内容现从独立域名 `cfi.miduo.org` 经 iframe 加载，
  与主站跨域隔离——这是故意的，防止用户上传的任意 HTML 触达主站登录态。若改为主站同源
  代理注入，等于让任意上传 HTML 读到访客 token（XSS 级安全回归）。故否决。
- **采用「存量回填」**（保持隔离域名 + 零安全回归 + 用户零操作）：
  - `HostedSite.SlideNavCompatVersion` 版本号；上传/重传写当前版。
  - `InjectSlideNavCompat` 改「先剥离任何旧版本注入块、再插当前版」，垫片升级时替换旧块。
  - `BackfillSlideNavCompatAsync`：版本落后/缺失的站点 HTML 从 COS 拉回重注入、原地覆盖、
    bump `ContentVersion`+`SiteUrl`（?v 击穿缓存）、升级版本号；幂等。
  - 接入 `HostedSiteBackfillService` startup 任务（30s 延迟 + 异常隔离）。
  - 垫片代码以后升级只需 `SlideNavVersion`+1，下次启动自动把存量换新版。
- **回填债务**：首次启动会下载+重传所有版本落后站点的 HTML（无批量限流），站点量极大时
  startup IO 偏重；后续启动因版本号已升级而跳过。必要时可加分批/节流或异步队列。

### 实现演进（重要）

- v1（首版）：框架感知（reveal/swiper/impress）→ scroll-snap → 合成左右方向键兜底。
  **缺陷**：真实用户 PPT 是 `<deck-stage>` 自定义元素 deck，它忽略 `isTrusted=false` 的
  合成事件，导致合成兜底无效；且垫片 stopPropagation 掉了 deck 原生可用的 Space/PageDown，
  反而帮倒忙。（首版用合成测试 deck「验收通过」是假象——合成 deck 不校验 isTrusted。）
- v2（当前）：改「可靠驱动优先」`resolveDriver()`：reveal/swiper/impress API +
  **任意标签含 `-` 且暴露 `next()/prev()` 的自定义元素** + 横向 scroll-snap 直驱。
  只有解析到可靠驱动才接管 + preventDefault/stopPropagation；无可靠驱动时只对上下方向键
  尽力合成且**不抑制原生**（不再废掉原生可用键）。
- v3：分档 + 透明可控 —— 高可信自动开 + 角落可关提示条；低可信(.slide≥2)仅邀请。
- v4（当前）：**一律邀请式（零自动劫持）** —— 按用户选择，任何幻灯片默认都不自动接管键盘，
  只在 iframe 角落弹邀请条「幻灯片：上下键翻页? · 开启」，用户主动点才绑定键盘；
  选择记入 `sessionStorage` 按 deck 记住（本会话内再开同 deck 直接生效）。彻底消除
  「静默注入 JS 劫持按键」的顾虑——不点就完全不碰任何键，误判普通页也零影响。

### 已知边界（open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 1 | reveal.js 带纵向子页（vertical stacks）的 deck，垫片调 `Reveal.next()/prev()`（按阅读顺序前进），而非 reveal 原生的「进入纵向子页」 | 极少数依赖纵向栈结构的 reveal deck，上下键语义被改为「统一前进」。为保证「上下键一定能翻页」的刻意取舍 | 若有反馈，对 reveal 改用 `Reveal.down()/up()` 优先、`next()/prev()` 兜底 |
| 2 | 既无任何可识别驱动（reveal/swiper/impress/带 next-prev 的自定义元素/scroll-snap 全不命中）、又忽略 `isTrusted=false` 合成事件的纯 JS deck，用户点「开启」后上下键兜底仍可能不生效 | 长尾 deck（v4 起为邀请式，需用户主动点开启）。此时不破坏原生键，只是开启后上下键无增益 | 评估直接 DOM 滚动或探测 deck 内部 index 字段 |
| 5（v4 已缓解） | 误判普通网页为幻灯片（主要靠 `.slide≥2` 松散启发） | v4 起一律邀请式，不点「开启」就完全不绑定键盘，误判最多多显示一个可忽略的角落邀请条，**不再劫持任何键** | 可进一步给邀请条加「不是幻灯片?隐藏」 |
| 12 | 存量回填在服务首启时集中跑，IO 偏重且无批量限流（承接已结清「零重传直接生效」#4 的尾巴） | 站点多时首启那一阵磁盘/网络压力偏高，正常请求可能变慢 | 回填分批 + 限流，或挪成后台低优队列 |
| 7（已修正 2026-08-18） | ~~iframe `sandbox` 原缺 `allow-fullscreen`~~ —— `allow-fullscreen` **根本不是合法的 sandbox flag**，浏览器报 `invalid sandbox flag` 并整条忽略，所以 deck 自带全屏按钮从加上那天起就没生效过，只在控制台留一行红字（用户 2026-08-18 反馈） | 全屏权限归 `allow="fullscreen"`（Permissions Policy），已改用它。新增守卫扫全仓 sandbox 字面量，非法 flag 直接判红（位置见文末「实现来源」） | — |

### 测试状态

- CDS 远端编译通过 + API/admin 容器 running（compile + boot 已验证）
- 端到端浏览器取证（2026-06-03，Playwright）：
  - **真实用户 PPT（`<deck-stage>` 自定义元素，原生只认左右键、上下键无效）**：经 v2 垫片后
    ArrowDown 连按 `_index` 0→1→2→3、ArrowUp→2、PageDown→3、Space→4→5，零 console 错误。
    完整部署路径验证（线上 API 注入 → COS → 浏览器）通过。
  - 负向：普通长文页面 ArrowDown 仍触发原生滚动（scrollY 0→120），垫片未接管 —— 保守判定生效。
  - 注入校验：marker 出现 1 次、原 deck 内容完整保留。
  - **存量回填取证（2026-06-03）**：用户原始 PPT（站点 264dfc，**从未重传**）经 startup
    backfill 后，COS 文件 marker=1、`?v` 已 bump；Playwright 直测该线上文件 ArrowDown
    `_index` 0→1→2、ArrowUp→1，零 console 错误 —— 零重传直接生效已验证。

---

## 分组级权限（受限专题/分类）已知边界（2026-06-12 引入）

分组级数据权限上线（`WebPageGroup.Visibility=restricted` + `AccessRules` 按成员/角色标签授权，
解析器 `PrdAgent.Core/Security/WebPageGroupAccess.cs`，xUnit 纯函数测试 15 例）。

### 已知边界（open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 8 | 列表过滤是「分组粒度」近似：站点同时共享给多个团队、且挂在 A 团队受限分组下时，B 团队成员在**列表**里也看不到它（单站点直查 `GetByIdAsync`/操作权限走 `ResolveSiteRoleWithGroup` 精确判定，B 团队角色不受 A 团队分组剥夺） | 多团队双重共享 + 受限分组的交叉场景（罕见）：列表隐藏与单查可见不一致 | 列表改聚合管道 join 分组做 per-site 判定，或接受为产品语义 |
| 9 | 受限分组对「空间级 editor 但未被分组授权」者不可见，但其在树导航之外的入口（如分享链接、library 转存副本）不经过分组裁剪 | 分享链接体系本就独立于团队权限（密码/有效期），与既有语义一致 | 如需「受限分组站点禁止外发分享」，在 CreateShare 路径补分组角色校验 |
| 10 | 角色标签改名无级联：成员标签是自由文本，改名/删除标签不会同步更新分组 AccessRules 里的 label 规则，旧规则变成「无人命中」 | 标签重命名后需到分组权限里重新授权 | 标签字典实体化（团队级 catalog + 引用计数 + 改名级联） |

| 13 | `SaveSharedSiteAsync`（保存分享站点到我的托管）仍在裸比 `ExpiresAt`，没走 `ShouldRejectExpiredShare` 的 visit 链接豁免。历史遗留 `Purpose="visit"` 且 `ExpiresAt` 已过去的链接，页面打得开、正文代理和提问也通了（两处已对齐判据），唯独「保存到我的托管」报已过期 | 判据抄了三份，PR #1351 对齐了其中两份（view / comment-and-ask）。第三份属于该 PR 范围之外的既有行为，按范围熔断规则记账不就地改：修它会改变一个本 PR 不涉及的端点的行为 | 把 `SaveSharedSiteAsync` 的过期判定也换成 `ShouldRejectExpiredShare`，三处彻底收敛到一个判据 |


| 14 | 提问配额 `INCR` 与首次 `EXPIRE` 不是原子的：进程在两者之间退出或 Redis 断连，计数键就永远没有 TTL；之后每次 `INCR` 都不再是 1、修不回来，该访客/该站点的配额键会永久累积直到触顶，然后**永久拒绝**——而返回给用户的 `Retry-After` 是个有限值，等多久都没用 | Review 第九轮（PR #1351）提出，判断成立。正解是把 INCR + 首次 EXPIRE 合成一段 Lua 原子执行 | 改 `IncrWithTtlAsync` 走 `ScriptEvaluateAsync`；顺带给存量无 TTL 的键加一条兜底（读到 TTL 为 -1 时补设） |
| 15 | 站点日配额拒绝时，上一层已经加过的**访客计数不退**。访客计数是跨站点共享的，反复去试一个已经触顶的站点，会把自己在别的站点上的额度也耗光 | Review 第九轮（PR #1351）提出，判断成立。第 8 轮已经加了 `RefundAsync`，这里只是漏了这条分叉 | 站点级拒绝返回前调一次访客维度的退回 |
| 16 | 打包型站点（Vite / React 等）的 `index.html` 往往只有一个根节点，正文全在 `.js` bundle 里，而 bundle 不在正文白名单、`HtmlToPlainText` 也会剥掉 script 内容。结果快照要么是空的、要么只有标题，却仍被当成「完整内容」——访客拿到 `ASK_NO_CONTENT`，或者得到一个「页面里没有提到」的错误断言 | Review 第九轮（PR #1351）提出，判断成立，且与已修的视频站属同一类：`UnsupportedReason` 目前只认视频。这一类的判据比视频复杂——不能只看站点类型，要看**抽出来的正文到底够不够用** | 把「能不能开提问」从「看站点类型」升级为「看快照结果」：开启前先构建一次快照，正文低于阈值就拒绝开启并说明原因；同时给已开启但快照退化的站点一条运行时提示 |
| 17 | 幻灯片站没有独立的「形态」标识：`HostedSite.SlideNavCompatVersion` 每次上传都无条件盖章（`HostedSiteService` 三处 Create + 一处 Reupload），它是垫片版本号、不是 deck 标记。所以站点卡片上分不出「这是一套 PPT」，只能在访客页凭正文里的框架痕迹（`slideDeck.ts` 的 `detectSlideDeck`）判 | 卡片形态角标只到「单页 / N 文件 / PDF / 视频 / Markdown」为止，没有「幻灯片」这一档；访客页的键盘邀请条依赖取回正文，取不回就不提示 | 上传时按正文特征落一个 `ContentForm` 字段（deck / doc / spa / media），前后端共用同一判据；或把 `detectSlideDeck` 的判据搬到后端在建站时算一次 |
| 18 | 访客侧分不出「链接已撤销」和「链接不存在」：`WebPagesController.ViewShare` 对两者都返回 `NOT_FOUND`（服务层 `share == null \|\| share.IsRevoked` 走同一分支）。前端 `shareFailure.ts` 因此把两种合成一档，文案里两种都提 | 被撤销的访客看到的是「可能被撤销了，也可能地址抄错」，而不是确定的「已撤销」；对分享者排查没影响，对访客只是措辞不够笃定 | 服务层给撤销单独一个错误码（如 `REVOKED`），控制器透传，前端 `SHARE_FAILURE_REGISTRY` 加一档即可（判据与注册表都已就位） |
| 19 | 上传进度只覆盖「字节送达」这一段：`uploadSite` 走 XHR 拿到的是真实上传进度，但服务端解包 / 识别入口那一段没有任何进度通道，弹窗只能报已用时（`uploadProgress.ts` 的 `processing` 档如实说明「这一步没有进度可报」） | 大 ZIP 在服务端解包期间，用户看到的是满进度条 + 计时，不是百分比。诚实但不够细 | 解包走 Run/Worker + SSE 推阶段事件（与规则 #6 的长任务可视化一致），前端把 `processing` 档换成真实阶段 |


| 18 | 上游返回 200 后立刻 `[DONE]`（或内容过滤 finish 但无文本）时，网关只产出 `Start`、没有 `Text` 也没有 `Error`。当前实现因为答案为空跳过落库，却照样发 `done`——前端把一条**空白助手消息**当成功回答呈现 | Review 第十轮（PR #1351）提出，判断成立。与第 1 轮修的「EOF 未收到 done」是同一族（都是把「没拿到答案」呈现成成功），但这次是服务端侧 | 发 `done` 之前检查答案非空；为空则发 `error` 或明确的「模型没有给出回答」，并按失败落库 |

| 19 | 提问配置抽屉读取配置失败时只清 `loading` 不禁用表单，保存按钮照样可点。此时表单里是一组**初始默认值**（关闭、空欢迎语、空题库、不允许匿名、默认额度），点保存会把站点已有配置整个覆盖掉——一次网络抖动就能让 owner 精心配好的题库消失 | Review 第十一轮（PR #1351）提出，判断成立。属数据丢失，但触发要「读失败 + 用户仍点保存」两个条件叠加 | 读失败时禁用表单与保存按钮，给一条显式重试；或把「未成功加载」与「加载到空配置」在状态上区分开 |
| 20 | 提问 SSE 只给 `sessionId`，既没有序号也没有「取回已完成消息」的端点。连接中断后服务端仍会把答案生成完并落库（这是 server-authority 要求的），但访客重开面板拿不回来，只能重问一次、再扣一次配额 | Review 第十一轮（PR #1351）提出，判断成立，且 `server-authority` 规则明写要求 `afterSeq` 断线续传。但这是**协议层能力补齐**，不是修一个 bug——要加序号、加取回端点、前端接续传 | 按 `server-authority` 补 `afterSeq` 风格续传，或至少加一个「取回本 session 已完成消息」的端点 |
| 21（已缓解 2026-08-18） | ~~缩略图重挂自愈与「已画出来的画面」在物理上冲突~~：跨域 iframe 仍然没有可读的「画出来了没有」信号，但两件事都不再需要这个信号了——① 缩略图与站内大预览改走**服务端代理取正文 + srcDoc**（与分享页 PR #1356 同一条路，判据抽成一份共用模块，位置见文末「实现来源」），内容在手里，不存在「传播中 pending」；② 地球占位符改为**常驻最底层**，iframe 画出东西就自然盖住、没画出来就露出占位符，不再用 1.2s 定时器把它撤掉（原先撤掉之后留下的是一块纯空白瓦片，正是用户报的「网页托管无法显示内容」） | 用户 2026-08-18 反馈。原条目的取舍（闪烁 vs 永久空白）现在只作用于**取不回正文的降级路径** | 见下方新条目 35 |
| 35 | 公开主页 `/u/:username` 的站点卡片仍走直链缩略图：取正文的端点 `GET /api/web-pages/{id}/content` 只对 owner / 共享团队成员开放，匿名访客拿不到，所以那一屏仍可能是「直链画空白」。因占位符已改常驻，最坏结果是显示地球图标而不是空白瓦片 | 本次修复的已知边界。要覆盖匿名访客需要一条公开可读的正文端点（或服务端截图），属新语义类别，按范围熔断规则不在本次展开 | 给公开站点补一条匿名可读的正文代理（可见性 = public 才放行），或改用服务端截图做缩略图 |
| 22 | 站内预览弹窗的「加载较慢」角标是固定黑底 + `text-token-secondary`，浅色主题下文字与底色对比度不足 | PR #1356 第三轮 review 提出，判断成立；属样式问题，不影响功能，按两轮熔断规则记账不就地改 | 改为主题感知的 surface/text 配对，或给这块固定深色面板套上既有的深色 token 上下文 |
| 23 | `SetAskConfigAsync` 里没有把「站点形态是否支持提问」写进同一次条件更新：Controller 先读一次形态、再无条件写；若这中间另一个请求把站点重传成视频，写入会把 `AskEnabled=true` 落到一个已不支持的站点上，已发出去的分享挂着必定 422 的入口 | PR #1358 第三轮 review 提出，判断成立；属并发窄窗（要两个请求交错），按两轮熔断规则记账 | 把形态判据下沉进 `SetAskConfigAsync`，与启用动作放进同一个条件更新（filter 里带上 `WrappedAssetType` 约束） |
| 24 | 追问时面板顶部仍显示上一条回答的模型与平台，直到新的 `model` 事件到达才刷新；若新请求在此之前失败，错误的模型归属会一直留着 | PR #1358 第三轮 review 提出，判断成立；违反 `ai-model-visibility` 的「实时」要求，但不影响功能 | 每次发起提问先清空 model，或把 model 绑到单条消息而不是整个面板 |
| 25 | 网关路由到推理型模型时，提问请求没有开上游的 reasoning 透传（`IncludeThinking=false`、body 里也没有 reasoning 开关），模型可能思考几十秒而面板只有心跳文案 | PR #1358 第四轮 review 提出，判断成立；`llm-gateway` 规则写明 OpenRouter 默认不转发 reasoning，要显式要两个字段。属体验补齐、跨模块，按熔断规则记账 | 请求体加 `include_reasoning` + `reasoning.exclude=false`，服务层 `IncludeThinking=true`，SSE 补一类 thinking 事件，前端渲染 |
| 26 | 正文快照的文件数上限是「入口文件 + 其余 12 个」而不是「总共 12 个」：入口先单独加进去，`Take(MaxFilesPerSite)` 再取 12，实际会下载解析 13 个；且恰好在「入口 + 12」这个边界上被丢弃数算成 0，超限本身也看不出来 | PR #1358 第四轮 review 提出，判断成立。是一个有界的 off-by-one（单文件体积上限与总量上限仍然生效），不属可阻塞类别，按两轮熔断规则记账 | 选取时把入口从配额里先扣掉，丢弃数也按扣除后的余额算 |
| 30 | 提问的 SSE 走的是裸 `fetch` 而不是共享的 `apiRequest`，因此没有「401 就刷新令牌重试」那套。登录用户把分享页开着直到令牌过期后再提问，会拿到一个被当成普通门禁失败处理的 401：既不刷新、也不清掉失效的登录态（`needLogin` 仍是 false），于是每次提问都重复同一个失败，直到别的请求顺带刷新了会话 | PR #1358 第五轮 review 提出，判断成立。要修得把刷新语义搬进 SSE 请求（`useSseStream` 也有同样的形状），属跨模块接线，按两轮熔断规则记账 | 给 SSE 请求接上共享的刷新-重试语义；或至少在 401 时清掉本地会话，让面板如实回到「需要登录」态 |
| 29 | 一次提问失败后，`failAssistant` 只把助手那条标成失败，对应的用户提问仍留在历史里。下一次提问拼历史时助手那条被滤掉、用户那条还在，于是发出去的是**连续两条 user**，模型可能回答上一条失败的问题而不是当前这条 | PR #1358 第五轮 review 提出，判断成立。影响面是「失败后紧接着追问」这一种序列，答非所问但不产生错误数据，按两轮熔断规则记账 | 历史改成按「成对的 user/assistant」拼，或把整个失败回合（含用户那条）一起标记并排除 |
| 31 | PDF 包装站的壳子从 `cdn.jsdelivr.net` 取 PDF.js 把 PDF 画成 canvas。桌面站内大预览已改成直连原始 PDF、绕开壳子，但**分享页与移动端仍走壳子**（移动 Safari / 微信 WebView 在 iframe 里渲染不了 PDF，绕不开），CDN 不可达时那里依然只剩一条降级下载链 | 验收发现大预览空白后查出的根因。壳子已补 12s 加载超时，不会再永久转圈；但「看得见正文」在 CDN 不通的网络下仍做不到。且超时只对**新上传**的 PDF 生效——壳子 HTML 在上传时就烘进对象存储了，存量站要重传才带上 | 把 PDF.js 自托管到托管域名（或主站同源）后由壳子就近取，彻底摘掉第三方 CDN 依赖；存量站另跑一次壳子回填 |
| 28 | 提问面板在「需要登录才能提问」这一态里只有一行说明加一枚 `LogIn` 图标，没有可点的登录控件，访客在面板里走到了死路 | PR #1358 第四轮 review 提出，判断成立但不属可阻塞类别：登录入口在分享页顶栏（「登录并保存」）本来就可达，功能没有不工作，只是这一屏里多走一步。按两轮熔断规则记账 | 把那枚图标换成真正的登录按钮，带 `redirect` 回当前分享页；顺带确认登录回来后面板保持展开、问题草稿不丢 |
| 27 | 分享面板挑开场问题时用的是**大小写敏感**的去重，而后端 `AskOpeningQuestions.Normalize` 落库前按大小写不敏感去重。用户挑了只有大小写不同的两条，界面显示两条、存下去只剩一条，且不提示 | PR #1358 第四轮 review 提出，判断成立。属「设了没生效」的静默丢弃，与已修的题库上限同族，但触发要用户刻意挑大小写变体 | 前端 add / toggle / 选中态三处统一改成与后端一致的大小写不敏感比较，判定收进 `askTypes` 唯一函数 |
| 33 | 提问失败时网关/上游的原始错误会写进对话消息落库记录，但这条记录只写不读——没有面向站点创建者的查看端点或前端入口，出错原因实际上任何人都看不到，只能靠服务端日志排查 | entropy-cleanup PR #1372 review（Codex）指出：D6 撰写的设计文档一度写成「供创建者事后审计排查」，但仓库内对 `HostedSiteAskMessages`/`HostedSiteAskSessions` 的引用只有写入与集合访问器，没有任何读端点或消费者，该用途并不成立 | 补一个仅站点 owner 可访问的失败消息查看入口（列表/详情皆可），把已经落库的原始错误利用起来；补齐后回来更新本条与对应 design 章节 |
| 34 | 匿名访客的提问配额闸按客户端 IP 哈希计数，同一 NAT 出口的多个访客共享同一个计数桶（互相触限），且计数不随浏览器会话刷新重置（只按小时窗口过期） | 撰写「向我提问」设计文档时核对配额闸实现发现的既有取舍，非本次改动引入 | IP 哈希是刻意的粗粒度兜底；如需更精确的访客识别需要引入设备指纹或匿名会话 cookie，属新语义类别，暂不展开 |

| 33 | 卡片形态角标缺两个数：PDF 页数、视频时长 | 设计稿屏 2 的角标是「24 页」「02:14」「1 / 24」，实现只有 ZIP 文件数与 HTML「单页」——PDF 页数要在上传时解析 PDF、视频时长要探媒体，后端目前都没有这两条链路。当前按「拿不到就不渲染角标」处理，不写「-- 页」 | 上传包装 PDF 时读页数落 `PdfPageCount`；包装视频时用媒体探针落 `VideoDurationSeconds`。幻灯片形态已在本轮解决（`IsSlideDeck` 上传时扫签名落库） |

### 「向我提问」重做成形变坞 + 开场问题自动生成（2026-08-26，open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 56 | 形变逐帧改的是 right/bottom/width/height，不是 transform | 这几个属性走布局而非合成层，低端机上四态切换可能掉帧。已用「形变途中关掉 backdrop-filter」压掉最贵的一项，但没做 FLIP（scale 模拟尺寸）改造——那要求内容层反向缩放，代价高于当前收益 | 真机上确认掉帧再改 FLIP |
| 57 | 提问历史只有本次访问的轮次 | 刷新页面就重新开始；跨设备的历史没有做。面板底部已如实写明，不假装有 | 要做得先决定匿名访客的身份口径（IP？浏览器指纹？），那是另一件事 |
| 58 | 开场问题自动生成的触发点有三处，都是 fire-and-forget | 开启提问 / 重新上传 / 分享页兜底。第三处意味着**存量站点的第一个访客看不到词条、下一个才有**——生成要几秒，不能让他等着 | 可以在上传完成就预生成（而不是等开启提问），代价是给永远不开提问的站点白烧钱 |
| 59 | owner 的配置抽屉开着时，重新上传触发的重算会覆盖他正看着的那份 | 竞态窗口窄（他得正好在抽屉开着时另一端重传同一个站点），且他一保存就翻成 manual、之后不再被覆盖 | 抽屉可以订阅站点变更，或保存时带上读取到的版本做乐观锁 |
| 60-bis（环境，非本次代码） | 分支预览里所有走网关的功能都答不出来 | 这套部署 `LlmGateway__Mode=inproc`，走 MAP 自己的 ModelResolver；而共享库里 `model_groups` 是空的、模型上的 legacy 标记（IsMain/IsIntent）也全是 false，于是 `[ModelResolver] 未找到可用模型（无池且 legacy 未命中）`。平台密钥和模型本身都是配好的（2 个平台 hasKey=true、8 个模型 enabled），缺的只是**模型池**。这不只影响「向我提问」——分支预览里任何 LLM 功能都是这个结果 | 在模型池页建一个 ModelType=chat 且 IsDefaultForType 的默认池（意图类再建一个 intent 池），或把预览的 `LlmGateway__Mode` 指向 llmgw serving。本次没动它：改的是共享库里的全局配置，影响面跨所有分支与生产（cross-project-isolation 通道 4） |
| 60 | 生成失败（读不出正文 / 模型给不出可用问题）会盖版本戳，此后同一版正文不再重试 | 这是有意的：不盖戳的话，一个永远读不出正文的站点会被每个访客各排一次生成。代价是「模型这次抽风」也被当成结论 | owner 有「重新生成」按钮可以手动破戳；自动重试要先有失败原因分类（读不到 vs 模型抽风），否则重试的是同一个必然失败 |

### 已修复（closed）

> 本节条目已全部结清，明细见文末「已结清（供回溯）」。

### 测试状态

- 前端：pnpm tsc --noEmit 通过；eslint 改动文件零新增告警；vitest 404 例全绿
- 后端：本地沙箱无 dotnet SDK（builds.dotnet.microsoft.com 不在网络白名单），已通过
  workflow_dispatch 触发本分支 GitHub CI（dotnet build + dotnet test 含新增
  WebPageGroupAccessTests 15 例）远端验证；CDS push 自动构建部署

## Web Hosting 评论

网页托管评论能力的已知边界、权限模型与验收状态。

> 模块：网页托管评论 | 更新：2026-05-30

### 背景

为「网页托管允许被评论」落地的评论能力，记录本次交付的已知边界与后续可补项。

### 已知边界（本次交付未做，刻意留尾）

| 项 | 现状 | 后续可补 |
|----|------|---------|
| 评论回复/盖楼 | 仅平铺单层评论，无 `ParentCommentId` | 如需讨论串，仿 `ReportComment.ParentCommentId` 扩展 |
| 评论编辑 | 仅支持发表 / 删除（软删 `IsDeleted`），不支持编辑 | 加 `PUT comments/{id}`，仿 ReportComment 编辑路径 |
| 实时推送 | 发表后本地乐观插入，不走 SSE；他人评论需刷新 | 复用 `GET /api/branches/stream` 模式做评论流 |
| 防刷 | 评论无独立速率限制（仅借分享 view 门禁） | 如遇滥用，加 per-user / per-site 滑动窗口（仿 `EnforceShareAccessAsync`） |
| 通知 | owner 不会收到「有人评论了你的站点」通知 | 接 `admin_notifications` 或团队活动流 |
| 合集分享评论 | 合集分享（多站点）评论只挂到 `sites[0]` 首个站点 | 如需逐站点评论，前端按 site 分区 + 后端按 siteId 查询 |
| 索引 | `hosted_site_comments` 未建索引（遵守 no-auto-index 规则） | DBA 手动建 `(siteId, createdAt)` 复合索引，写入 [doc/guide.platform.mongodb-indexes.md](./guide.platform.mongodb-indexes.md) |

### 权限模型（已实现）

- 读：站内路径走 `GetByIdAsync`（owner / 团队成员）；分享路径走分享可见性 + 密码门禁（owner-only / logged-in / public）。访客未登录也可读公开分享评论。
- 写：恒需登录。站内路径需对站点有访问权；分享路径需过门禁 + 站点 `CommentsEnabled`。
- 删：评论作者本人 或 站点 owner。
- 开关：仅 owner / editor 可切换 `CommentsEnabled`（默认 true，存量站点反序列化为 true）。

### 验收状态（2026-05-31 已通过）

- 前端：`pnpm tsc --noEmit` 0 error、`pnpm lint` 改动文件 0 告警。
- 后端：CDS 远端编译——期间修复 3 轮真实编译错误（接口未实现 CS0535×6、`AddCommentRequest` 与 PmAgent 重名 CS0101、前端评论入口未接线 TS6133），最终 deploy 流水线全绿、L1/L2/L3 探针 200。
- API E2E（灰度直连，AI 密钥 impersonate）：列表/发表/再查/开关/关闭后发表 403/重开/删除 8 条用例全过；存量站点 `commentsEnabled` 反序列化为 true。
- 视觉验收：Playwright 真人路径 10 张截图（站点卡评论管理弹窗发表/开关 + 分享页访客只读 + 登录可评）全部通过，已归档知识库并自查可打开。
- 报告分享链：https://fervent-meitner-lcue8-claude-prd-agent.miduo.org/s/lib/ftDV5mobkfHt?entry=7f3cdff238d640448019536ba23f75a7
- 早前「CDS building 30 分钟」判断有误：实为容器构建失败进入 error 态（CDS proxy 把 error 也包成 `status` JSON 返回 200，误导了轮询）；真正根因是编译错误，看 `branch logs --profile api-prd-agent` 才暴露。

### 关联

- 后端：`HostedSiteComment.cs`、`HostedSiteService.cs`（评论段）、`WebPagesController.cs`（评论端点）、`IHostedSiteService.cs`（DTO）
- 前端：`components/web-hosting/CommentsSection.tsx`、`components/web-hosting/SitePreviewModal.tsx`、`pages/SharedSitePage.tsx`、`services/real/webPages.ts`

## Web Hosting 客户端 IP

分享访问统计取到的是内网地址，本文记刻意留尾的原因与彻底方案的前置条件。

> 模块：网页托管 / 分享访问统计 | 更新：2026-06-01

### 背景

PR #699 修复「分享统计取到 Docker 内网 IP（172.20.* / ::ffff:）」时新增
`HttpRequestExtensions.GetRealClientIp`。经多轮 review，方案在「防伪造」与「穿透多层代理拿真实
访客 IP」之间存在本质冲突——二者不可兼得，除非提供部署侧「可信代理地址」配置。

维护者 2026-06-01 最终决策：**只信不可伪造的代理覆盖值，不解析 X-Forwarded-For**。
即 `X-Real-IP`（反代 `$remote_addr` 覆盖写）→ `RemoteIpAddress`（socket 对端）。

### 已知边界（刻意留尾，维护者已知并接受）

| 项 | 现状 | 影响 | 后续可补 |
|----|------|------|---------|
| 多层 public 拓扑下记到代理 IP | `public-nginx→gateway→branch-nginx→api`，内层 nginx 用 `$remote_addr` 覆盖 `X-Real-IP` = gateway 内网地址 | 生产环境分享/站点访问统计的 IP、独立 IP 计数会**坍缩到 gateway 代理 IP**，而非真实访客——即原始诉求「正式环境拿真实访客 IP」在此方案下未达成 | 见下「彻底方案」 |
| 单层/直连拓扑正确 | CDS 预览（Cloudflare→branch-nginx 直连）下 `X-Real-IP` = Cloudflare 边缘公网 IP | 预览域名统计能看到边缘 IP（非内网），可用 | — |

为何取此方案：彻底 spoof-safe 的 XFF 解析必须知道「可信代理地址」（hop 数 / CIDR），而该输入
是部署侧拓扑配置，代码推断不出来；且该统计字段语义为「仅用于访问统计 / 审计展示，不作安全判定」。
权衡后维护者选择「绝不接受可伪造值」优先于「穿透多层代理的精确性」。

### 彻底方案（需要部署侧输入时再做，可同时满足防伪 + 真实访客 IP）

1. `app.UseForwardedHeaders(new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor, KnownNetworks = <内层反代 CIDR>, ForwardLimit = <可信跳数> })`；
2. 由运维提供 public-nginx / gateway / branch-nginx 的确切内网 IP 段作为 `KnownNetworks`（注意不能放整段私网，否则 LAN 客户端会被当可信代理）；
3. 改用框架填好的 `HttpContext.Connection.RemoteIpAddress`，删除本 helper 的 X-Real-IP 优先逻辑；
4. 这是**全局中间件**，影响所有 `RemoteIpAddress` 消费方（限流、其它日志），需回归。

### 关联

- 消费：`WebPagesController.cs`（分享 view / 评论）、`WebPageAnalyticsController.cs`（record-view）、`HostedSiteService.cs`（`MaskIp` 脱敏展示）
- 部署拓扑：`deploy/nginx/nginx.conf`、`deploy/nginx/public-nginx.example.conf`
- 来源：PR #699 Codex/Bugbot 多轮 review + 维护者决策

---

## 一步分享（2026-08-25 引入）

卡片上的「分享」从「两层弹窗」改成就地展开的下拉：一键生成链接（登录可见 · 7 天 · 生成即复制），
可见性与有效期在下拉里就地改（后端 `PATCH /api/web-pages/shares/{id}`），密码 / 数字短链 /
开场问题这些低频项仍走原来的配置弹窗。

### 已知边界（open）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 36 | **两套默认值并存**：下拉一键生成用「登录可见 + 无密码 + 7 天」，而「高级设置」弹窗仍是「仅我可见 + 带密码 + 7 天」。同一个入口点进去，走哪条路得到的初始档位不同 | 用户从下拉点进高级设置，看到的可见性不是他刚才那条链接的档位，而是弹窗自己的默认；容易误以为设置被改了 | 让配置弹窗在「从下拉进来且已有链接」时以那条链接的现值预填，而不是用自己的默认；或把两套默认收敛成一份 SSOT |
| 37 | 下拉里改不了密码。密码是三态（保持 / 设置 / 清除），塞进 PATCH 要多一组字段，本次刻意没做 | 想给已有链接加/去密码，得走高级设置重新建一条 | `PATCH` 补 `passwordAction: keep\|set\|clear` + `password`，下拉加一行 |
| 38 | 下拉锚在卡片 hover 条里的「分享」按钮上，指针移进下拉后 hover 条淡出，那枚按钮跟着消失（下拉本身 portal 到 body，位置不受影响） | 纯观感：刚点的按钮不见了。下拉照常可用 | 让卡片在「自己的分享下拉开着」时保持 hover 条可见 |
| 39 | 撤销不可逆且无法清除，自测每跑一次就在「已撤销」层留一行。2026-08-25 的验证在真实账号下留了 4 行（`[每日验收] Markdown 站`，其中一行原因写了「自测探针」） | 分享档「已撤销」层里混着自测痕迹 | 自测脚本改成复用固定 fixture 链接（每日验收脚本已是这么做的），不要每次 forceNew |

### 已修复（closed）

| # | 边界 | 修复 |
|---|------|------|
| 40 | ~~分享列表给的地址是死链~~：有数字短链时拼成 `/s/wp/{seq}`（那条路由按 token 查，号码查不到，实测 404）；合集拼成 `/s/wp/c/{token}`（路由表里没有这一段，直接落 404 页） | 统一为「有 seq 走 `/s/{seq}`，否则 `/s/wp/{token}`」；守卫 `sharePath.test.ts` 把 `App.tsx` 的 `<Route path>` 读出来断言拼出的地址能被匹配（做过红绿闭环） |
| 41 | ~~分享档渲染在屏框外、顶栏之前~~：切到分享档时列表在最上、顶栏在它下面、顶栏下面剩一大块空框 | 挪进屏框内与资产库同级，共用同一条顶栏并撑满剩余高度 |
| 42 | ~~列表里的「续期历史 N 次」是假的~~：`renewalCount` 数的是整本审计账（含 created / reused），一条从没续过期的链接也显示「1 次」 | 只数 `Action == "renewed"` |

---

## 访客阅读页 vs 设计稿（2026-08-25 机械核对）

用设计样例数据回放后量的实现侧规格，与设计稿画板「11 阅读页-深」逐条比。首轮报文案覆盖率 41%、
23 条硬缺失，**逐条复核后大幅收窄**——原始数字把三类东西混在了一起，只有第一类是要改的。
档位表与样例数据都固化在复刻技能的导出与 fixture 目录里（位置见文末「实现来源」），重跑可复现。

### 一、真差异（四条已于 2026-08-26 修完，closed）

| # | 差异 | 影响 | 已怎么改 |
|---|------|------|--------|
| 43（已修） | ~~提问面板的免责句被截短，只有「回答只依据这个页面的内容。」~~ | 访客不知道问了正文没写的东西会得到什么，容易把「页面里没有提到」当成故障 | 按画板逐字补全后半句；「只依据本页正文」用 `<strong>` 内联强调，与画板同结构 |
| 44（已修） | ~~开场问题上方缺分组标题~~ | 访客不知道那几条是作者预备的问题，容易当成系统猜的 | 加「开场问题 · 来自站点题库」 |
| 45（已修） | ~~输入框 placeholder 是「问点什么…」~~ | 没说清「只问这一页」这个边界，而这正是本功能的核心约束 | 换成「就这一页提个问题」 |
| 46（已修） | ~~提问面板没有配额行~~。后端有配额判定，但此前只在**拒绝时**随错误下发，面板初始化拿不到剩余数 | 访客问到被拒才知道有上限（预期管理：不知道还能做多少） | 新增 `GET /api/web-pages/shares/view/{token}/ask/quota`：读 Redis 计数但**不 INCR**，门禁与提问路径逐条同源（同一个 `ResolveShareSiteAsync`、同一个 `GetAbuseControlClientIp`），读不到就返回 `available:false`、前端整块不渲染。位置照设计稿放**顶栏右侧**两行 mono，不放消息区——消息区那行会随对话滚走 |

额度这条旁路有三条静默失效路径（前端路径拼错 / 后端换段名 / 匿名开放被摘掉），表现完全一致：
那两行安静消失、无报错、无用例变红。因此配了一条接线守卫（位置见文末「实现来源」），
断言前端拼出的路径能被后端的路由声明接住、且该接口对匿名开放；三条逐个改坏确认变红后恢复。

### 一之二、顺带查出来的：访客阅读页没有浅色档（open）

| # | 情况 | 证据 | 影响 |
|---|------|------|------|
| 55 | 设计稿画了「11 阅读页-**浅**」这块画板，但访客实际永远只看得到深色 | 公开分享路由**不在 AppShell 之内**，而落 `data-theme` 的只有 AppShell；访客页也没有任何切换控件。取证时手动把 `data-theme` 钉成 light，整屏能正确变浅（token 全部解析、无硬编码色），说明**样式是齐的、只是没人去设那个属性** | 白天在手机上打开一份分享报告是一整屏深色。属于既有缺口，不是本轮改出来的 |

要补的话是两件事：给访客页一个自己的主题来源（跟随系统 `prefers-color-scheme`，或页面自带一个切换），
以及决定分享页要不要沿用站内的持久化偏好——访客没登录，站内那份偏好对他不成立。

顺带记一条量法陷阱：Playwright 的 `colorScheme: 'light'` 对本项目**无效**。
主题来自持久化的偏好 store 而不是 `prefers-color-scheme`，所以那样跑出来的「浅色截图」
其实还是深色的——一张看不出问题的假证据。要验浅色只能显式落 `data-theme`。

### 二、设计稿画的是合成态，实现里不存在那个时刻（需要产品裁决）

| # | 情况 | 说明 |
|---|------|------|
| 47 | 设计稿那一屏**同时**画了「开场问题」与「本次回答：{模型} · {平台} · 经 MAP LLM Gateway」 | 实现里开场问题只在一条消息都没问时显示，模型名只在流开始后才知道——两者互斥，没有任何运行时刻能同时满足。首轮把模型行记成「缺失」是错的：提问面板顶栏本来就渲染模型与平台，代码里还标着「模型名必须可见」那条规则。真正的差异只有位置（设计稿放答案下方、实现放顶栏副标题）与是否带「经 MAP LLM Gateway」这句归属 |
| 48 | 设计稿画了「保存到我的托管」+「登录」两个动作 | 实现是同一个按钮按登录态切文案（未登录「登录并保存」/ 已登录「保存到我的托管」）。首轮量的是匿名态，所以只看到前者。是否该拆成两个控件是产品取舍 |
| 49 | 提问面板与评论区在设计稿里同屏上下并列 | 实现里提问是覆盖整页的右侧抽屉，打开它之后评论入口点不到，因此设计稿那一屏（含 11 条评论区文案）在实现里到不了。要么把提问改成不遮挡的侧栏，要么承认这是有意取舍并更新设计稿 |

### 三、实现有意与设计稿不同（保留）

| # | 情况 | 理由 |
|---|------|------|
| 50 | 顶栏不展示「由 {分享人} 分享」前缀 | 代码里明确注释「不再展示『{用户} 分享给你的』前缀，直接显示站点标题」——是先前的有意决定，不是漏做。要恢复得先推翻那个决定 |
| 54 | 模型名放**顶栏副标题**，设计稿放在输入框下方（「本次回答：{模型} · {平台} · 经 MAP LLM Gateway」） | `ai-model-visibility` 第 1 条要求「UI 最顶部展示当前调用的模型」。照设计稿挪到底部会与该规则冲突，且会把站点标题挤出顶栏。保留顶栏位置；「经 MAP LLM Gateway」这句归属没有实现，因为网关名不由 `model` 事件下发，编一个不算有根 |

### 四、顺带修掉的取证缺陷（closed）

| # | 缺陷 | 修复 |
|---|------|------|
| 51 | ~~按 y 区间切画板~~：并排摆放的三个上传态纵坐标相同，取出的文案是三屏并集（12 屏里 5 屏的文案证据是错的，而文案证据正是覆盖率的比对基准） | 改按画板自己的标注属性选择器切 |
| 52 | ~~tokens-map 跨维度按纯数值乱配~~：字号 18px 会配上圆角 token 报「已有 token」 | 按维度限定候选 token；某维度没有任何候选时如实报「本项目不用 token 管这个维度」 |
| 53 | ~~量实现页时拿固定秒数当「加载好了」~~ | 改成等到有内容为止；正文在 iframe 里的屏（阅读页外层只有 95 字）可以声明自己的真实下限，失败信息会提示有几个 iframe |

### 修完之后重跑（2026-08-26，同一份样例数据、同一块画板、同一套参数）

文案覆盖率 **41% → 51%**（命中 16 → 20 条），正好等于修掉的四条。剩下 19 条硬缺失逐条有归属，
没有一条是「还没做」：

| 归属 | 条数 | 说明 |
|---|---|---|
| 提问面板遮住评论区（#49） | 12 | 评论区那一屏在实现里到不了——提问是覆盖整页的抽屉 |
| 模型行（#47 / #54） | 3 | 「本次回答：{模型}」「·」「{平台} · 经 MAP LLM Gateway」，位置有意不同 + 归属没实现 |
| 登录态相关（#48） | 2 | 「保存到我的托管」「登录」，量的是匿名态 |
| 分享人前缀（#50） | 1 | 有意保留 |
| 量法看不见（新） | 1 | 「就这一页提个问题」在实现里是 `placeholder` **属性**，设计稿里是文本节点。覆盖率只读文本节点，所以它永远算缺失——已在取证脚本里显式读一次属性值断言，不拿一个读不出结论的判据替自己开脱 |

样例数据 4 条全部命中、零穿透（穿透一次就意味着量的是真实数据，覆盖率当场失去意义）。

### 这轮核对本身的教训

覆盖率是**状态相关**的：拿一个运行时状态去比一张合成画板，缺失数会被大幅高估。首轮 23 条里
只有 4 条是真要改的，其余是「量的不是同一个状态」或「有意不同」。以后跑这类核对，先问一句
**设计稿画的这一屏，实现里有没有哪个时刻能同时满足**——不能的话先拆状态再比，
否则报告读起来像实现缺了一大半。

---

## 已结清（供回溯）

下列条目台账里已自己标记为解决/交付，移到文末只为让上文只剩未还的账；内容原样保留。

### 已知边界（本节的行均已解决）

| # | 边界 | 影响 | 后续可补 |
|---|------|------|----------|
| 3（已解决，PR #721 review） | ~~仅覆盖用户上传路径，未覆盖 API/工作流生成内容（CreateFromContentAsync）~~ | `CreateFromContentAsync` 现也注入当前版垫片 + 标版本号（Codex P2 反馈），API/工作流/工作空间发布的幻灯片创建即生效，无需等重启 backfill | — |
| 4（已解决） | ~~垫片随上传注入一次，历史站点不含垫片需重传~~ | 已由 startup 存量回填解决（见上「零重传直接生效」），老 PPT 无需重传自动生效 | 本条已解决；回填首启的 IO 尾巴另立活账（见上方「已知边界 / 后续可补」#12） |
| 6（已修复，PR #721 review） | ~~回填对 `saved-share` 引用副本按 `savedId` 重建 SiteUrl→404 + 写回原站共享对象；下载瞬时失败仍升级版本号致永久跳过；saved-share 不刷新 `?v=` 致 library 访客读旧缓存~~ | saved-share 回填改为**检验地面真值**：下载共享对象、确认已含当前版 shim 才刷副本 `?v=`+标版本，确认不了就 defer 下次重试——对任意回填顺序 / 原站 deferred / 下载失败都正确，根除「副本提前标版本后再不刷新」整类竞态。普通站下载失败 `deferred` 保旧版本重试；URL 一律取入口真实 CosKey 不按 site.Id 推断；回填先原站后副本（让副本同 pass 即能确认） | Codex P1/P2 + Bugbot ×4 反馈，时序补丁三轮后换结构性解 |
| 32（已解决，entropy-cleanup PR #1372） | ~~「向我提问」没有对应的 `design.*` 章节~~ | 已在 [design.web-hosting.md](./design.web-hosting.md) 新增「向我提问」章节，覆盖为什么只依据本页正文回答、配额闸设计、开场问题三态语义、数据流；对应 changelog `2026-08-11_网页托管向我提问.md` 已登记进 `changelogs/.entropy-manifest.yml` | — |

### 已修复（closed）

| # | 边界 | 修复 |
|---|------|------|
| 11 | ~~`CopyToTeamAsync`（网页复制进团队）只校验团队级 owner/editor 角色和分组归属团队，缺失 `SetSiteGroup` 已有的受限分组写权限门控——团队有编辑权但受限分组无编辑权的用户可把网页复制进受限分组（越权写入）~~（已修复 2026-07-09，#802） | 补齐 `WebPageGroupAccess.IsRestricted -> ResolveGroupRole` 校验，与 `SetSiteGroup` 同款，无编辑权抛 `UnauthorizedAccessException` |

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 总览 | `prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs`、`prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs`、`prd-admin/src/pages/WebPagesPage.tsx`、`prd-admin/src/pages/ShareViewPage.tsx` |
| 预览判据与取正文 | `prd-admin/src/components/web-hosting/previewHtml.ts`、`prd-admin/src/components/web-hosting/useSitePreviewHtml.ts`、`prd-admin/src/components/SitePreview.tsx`、`prd-admin/src/components/web-hosting/SitePreviewModal.tsx` |
| 预览守卫 | `prd-admin/src/lib/__tests__/iframeSandboxTokens.test.ts`、`prd-admin/src/components/web-hosting/sitePreviewWiring.test.ts`、`prd-admin/src/pages/ShareViewPage.preview.test.ts` |
| 提问坞（四态形变 / 几何守卫 / 共用对话流） | `prd-admin/src/components/web-hosting/ask/AskDock.tsx`、`askDockGeometry.ts`、`askDockGeometry.test.ts`、`AskThread.tsx`、`AskWidget.tsx`、`askDock.css` |
| 开场问题自动生成（判据 / 生成器 / 接线守卫） | `prd-api/src/PrdAgent.Core/Models/AskOpeningQuestions.cs`、`prd-api/src/PrdAgent.Infrastructure/Services/AskOpeningQuestionGenerator.cs`、`prd-api/tests/PrdAgent.Tests/AskOpeningQuestionGeneratorTests.cs` |
| 提问剩余额度（端点 / 前端 / 接线守卫） | `prd-api/src/PrdAgent.Infrastructure/Services/AskQuotaService.cs`、`prd-admin/src/components/web-hosting/ask/useAskQuota.ts`、`prd-admin/src/components/web-hosting/askQuotaPath.test.ts` |
| 关联 | `prd-api/src/PrdAgent.Api/Extensions/HttpRequestExtensions.cs` |
| 设计档位表（12 块画板，带画布 sha256） | `.claude/skills/design-replication/exports/web-hosting-v2/design-spec.{json,md}` |
| 阅读页样例数据（录制-回放） | `.claude/skills/design-replication/fixtures/web-hosting-v2/11-reader/` |
| 逐画板切图与逐条文案 | 复刻技能 `extract-design.mjs` 的产出（`design/index.json` + `text-<画板>.txt`） |
