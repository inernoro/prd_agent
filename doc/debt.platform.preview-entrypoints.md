# 预览入口下发（Preview Entrypoints）· 债务台账

> **版本**：v1.0 | **日期**：2026-07-29 | **状态**：开发中

## 总览

当前 open: 3（PE-transition-window / PE-env-staleness / PE-long-branch-hash）/ 已落地待验证: 6（PE-ssot-inversion / PE-truncation / PE-console-subdomain-rename / PE-truncation-readability / PE-consumer-sweep / PE-llmgw-console-mapnav）/ 总计: 9

记录「分支预览域名怎么产生、谁有权推算它」这条链路上的欠账。

---

## 背景

CDS 用 `cds/src/services/preview-slug.ts` 的 `computePreviewSlug` 产出分支 slug，用
`forwarder-route-publisher` 把 `<previewSlug>.<root>` 与命名子域 `<previewSlug>-<sub>.<root>`
写成显式路由记录。这一套在 CDS **内部**是 SSOT：解析走前向匹配（重算再比），不做反向解析，
v1/v2/v3 三代格式都能兼容。

问题出在 CDS **外部**：MAP 前端 `prd-admin/src/lib/llmGatewaySso.ts` 曾经自己按
`location.hostname` 拼 `<预览 slug>-llmgw-web.miduo.org`，这是第二份域名实现，违反根
`CLAUDE.md` 规则 #11（禁止自己 slugify / 拼域名）。

2026-07-29 现场事故：分支 `claude/llmgw-self-service-panel-redesign-f4oeh6` 的 previewSlug
长 57，加 `-llmgw-web`（10）= 67 > 63（RFC 1035 单标签上限）。CDS 按判据**跳过不发布**
这条路由，前端却照拼，用户点「模型网关」得到的提示是「登录凭据未通过安全校验」——
票据其实签发成功了，问题在部署拓扑，排查方向被完全带偏。

---

## 台账

### PE-ssot-inversion · 把推算权从消费方收回平台 —— 已落地待验证

**做法**：CDS 在部署时注入 `CDS_PREVIEW_URL` 与 `CDS_SERVICE_URLS`（JSON: subdomain → URL），
prd-api 读取后由 `POST /api/llm-gateway/sso/ticket` 的 `console` 字段下发，前端只消费。

链路：`cds/src/services/preview-entrypoints.ts`（计算 SSOT）→ `env-provenance` 第 4.6 层
（平台事实，强制覆盖，项目 env 不得伪造）→ `PrdAgent.Infrastructure/Deployment/PlatformEntrypoints.cs`
→ `LlmGatewaySsoController.ResolveConsoleTarget()` → `prd-admin/src/lib/llmGatewaySso.ts`。

四态明确（第 ③ 态是过渡期专用，见下）：

| 条件 | 结果 |
|---|---|
| 表里有 `llmgw-web` | 用它 |
| 有表但没这一项 | 「该入口确实没发布」（子域超 DNS 63 上限） |
| 是 CDS 预览但没有表 | 「平台版本早于该能力，地址未知，CDS 更新后自愈」 |
| 非预览且没有表 | 正式环境，同源 `/llmgw/` |

**已验证**：CI（commit `a11a0a6`）Server Build & Test 绿——C# 编译通过、`dotnet test`
含新增 `PlatformEntrypointsTests` 全绿；CDS Build & Test 绿（4297 测试 + tsc）；
Admin Dashboard Build 绿（882 测试 + tsc + lint）。CDS 已用该 sha 镜像重新部署。

**未验证**：浏览器里的实际提示文案。本机无 MAP 管理员凭据，跳转入口需真人管理员会话
（控制器显式拒绝 Agent Key），未能点击取证。

**上线前提**：入口注入是 CDS 侧改动，只有 CDS **自身**（跑 `main`）自更新到含本次改动的
版本之后，预览容器才会拿到 `CDS_SERVICE_URLS`。合入 main 前，所有预览环境命中第 ③ 态。

### PE-transition-window · 过渡期预览环境失去网关入口 —— open（有界，自愈）

CDS 平台自更新到本次改动之前，预览容器拿不到入口表。此前那些**子域长度正常**、
跳转本来能用的分支，现在会看到第 ③ 态提示而不是直接跳过去。

为什么接受：替代方案是保留前端的域名推算做兜底，那等于把本次要消灭的第二份实现
再留一份，与整改目标直接冲突。选择是「明确告知未知」而不是「静默猜一个」。
影响面仅限分支预览（正式环境走同源路径，行为不变），且 CDS 更新后自动恢复。

### PE-truncation · 超长分支拿不到网关入口 —— 已落地待验证

原先 `capPreviewSlug` 只作用在 previewSlug **本身**，复合标签 `${previewSlug}-${sub}`
超长时是**跳过不发布**，长分支点不开网关控制台。现已把截断提到复合标签这一层
（`namedServiceLabel`）：按 `-` 段截断 slug + 接 8 位 sha1 摘要压进 63 内。

**摘要不可省**：截断会丢唯一性，前几段相同的两个长分支会塌成同一个 host、互相抢路由
——这正是发布端注释里原本拒绝截断的理由。

同批修掉一处会立刻出事的接线：发布器写 host、`replica-loadtest` 与 `replica-sets`
两处 SSRF 白名单此前各自拼 `<slug>-<sub>`，截断一上线三者算出的就不是同一个 host
（直达链接会被自己的 SSRF 闸挡掉）。现统一走 `namedServiceLabel`。

短分支行为逐字不变（不超限原样返回），无回归面。

### PE-env-staleness · 入口表在容器创建时定格 —— open（已知边界）

注入发生在容器创建时。若之后给项目新增了带 `cds.subdomain` 的 build profile，
**已在跑的容器不会看到新入口**，要等下次部署。

判断：可接受。新增服务本身就要重新部署才能起容器，同一次部署里两边一致。
若将来出现「不重启就要感知新入口」的需求，再考虑改成运行时查询平台接口。

### PE-consumer-sweep · 全仓守卫 —— 已落地待验证

单文件断言只锁得住已知的那一个文件，锁不住下一个人新建的文件 —— 这正是同一个反模式
能长出三份拷贝的原因。已加 `prd-admin/src/lib/__tests__/previewHostDerivation.guard.test.ts`：
扫 `prd-admin/src` 与 `llmgw/web/src` 全部源码，命中即红，例外必须写进 ALLOWLIST 并注明
理由与清除条件。

判据盯**构造**不盯**提及**：首版写成「出现 miduo.org 就红」，立刻误伤了联系邮箱
`contact@miduo.org` 与产品截图文案 `map.miduo.org`。那种误报会逼后来人把无辜文件塞进
例外清单，守卫就此失效。现判据是「用模板拼预览域名」「根域后缀常量」「网关子域后缀常量」
三条，已做红绿闭环（塞一个假推算文件进去两条同时变红，删掉转绿）。

当前例外只有 1 条：`llmgw/web/src/lib/mapNavigation.ts` 的兜底推算（见下条）。

### PE-console-subdomain-rename · 控制台子域 llmgw-web → llmgw —— 已落地待验证

`-web` 是废字（llmgw 本来就是 web 控制台），还白占 4 个 DNS 标签额度 —— 长分支名下
这 4 个字符正是「发布得出 / 发布不出」的分界。2026-07-29 改名为 `llmgw`。

**旧地址不断**：发布器对每个规范子域同时发布 `LEGACY_SUBDOMAIN_ALIASES` 里的历史名
（`llmgw` → 也发 `llmgw-web`），入口表同样两个 key 都给。存量链接、存量部署（compose
未重新导入、profile 里仍写旧名）都照常工作；prd-api 侧解析也先查新名再回退旧名。

别名什么时候能删：确认没有存量链接/文档还指着旧名之后，从 `LEGACY_SUBDOMAIN_ALIASES`
去掉即可 —— 判据集中在一处，不散落。

### PE-truncation-readability · 截断只在 `-` 段边界下刀 —— 已落地待验证

首版按字符硬切，切出 `...-f4oeh6-cla` 这种半截词，用户反馈「人类不知道怎么拼」。
改为按 `-` 分段丢弃整段，截出来的每一段都是完整单词。摘要仍保留（段截断照样会
让前几段相同的长分支撞 host）。无连字符的超长 slug 退回字符硬切兜底，避免空串。

### PE-llmgw-console-mapnav · 控制台反推 MAP 地址是第三份域名实现 —— 已落地待验证

`resolveMapHomeHref` 按 `location.hostname` 剥控制台子域后缀来推 MAP 主入口 —— 与 MAP
侧刚拆掉的那份同源，且硬编码 `-llmgw-web`，子域一改名就整片失效（「返回 MAP」和教程
深链一起断）。

**已改为平台下发**：console-api 读 `CDS_PREVIEW_URL`（分支主入口 = MAP），经匿名的
`/gw/healthz` 下发 `mapHomeUrl`；`getHealth()` 收到即喂进 `setPlatformMapHome`，
`resolveMapHomeHref` 优先返回权威值。喂值放在 api 层而不是页面里，页面一行未改
（也就不碰 `GatewayDataDomainGuardTests` 的 343 条跨模块源码契约）。

**保留的兜底**：平台没下发时（正式环境 / 旧版 CDS / 首帧尚未拿到 health）仍走后缀推算，
后缀表收敛在文件内唯一一处、新旧名都认。这条兜底是全仓守卫当前唯一的例外。
待所有部署都下发 `mapHomeUrl` 后即可删掉推算分支与该例外。

### PE-long-branch-hash · 超长分支的 host 仍会出现 8 位摘要 —— open

用户明确指出摘要「不符合设计」：`ff49186f` 和先前的半截词 `cla` 是同一类问题 ——
人读不出、记不住、拼不对。

**现状影响已大幅收窄**：子域从 `llmgw-web` 缩到 `llmgw` 省出 4 个字符后，previewSlug
≤57 的分支一律原样发布、不含摘要（本分支 57 恰好压线，规范入口是完整可读的
`llmgw-self-service-panel-redesign-f4oeh6-claude-prd-agent-llmgw`）。摘要只在
slug > 57 时出现，即分支尾段超过约 40 字符。

**为什么没有一了百了**：纯函数式命名要同时满足「长度有界」「不依赖全局状态」
「无碰撞且可读」是不可能的 —— 截断必然可能让前几段相同的两个长分支塌成同一个 host、
互相抢路由（发布器早年因此宁可跳过不发布）。摘要是放弃「可读」换「无碰撞」。

**正解是放弃「不依赖全局状态」**：分支创建时分配一个**短、可读、存下来**的标签
（从分支尾段派生，同项目内重名就追加 `-2`），host 用存储值而非现算。Vercel / Netlify
都是这么做的。四个消费方（发布器 / 网关 URL / 入口表 / 两处 SSRF 白名单）手里都有
branch 实体，改读存储字段即可，无存储值的存量分支回落现有算法。

**未做的原因**：它改变所有预览 host 的生成语义，影响面是整个共享 CDS 的全部项目，
而本机无法端到端验证（CDS 平台未跑本分支代码）。需要用户拍板后再动。

## ONB-key-usability — 新人清单的「可用密钥」只镜像了 scope 一项

**状态**：open（边界已知，影响面窄）

`llmgw/web/src/lib/onboarding.ts` 判「这个租户有没有一把能用的密钥」，目前镜像了
serving 侧三项判据里的三条：`enabled`、未过期、scope 含业务调用（`invoke` /
`stream:invoke` / `raw:invoke`，对应 `GatewaySuccessorObservationPolicy.IsBusinessInvocationScope`）。

**没有镜像**的还有 `GatewayRuntimeGovernance` 的另外三项：`purpose`（`AllowsDataPlaneRequest`
按 sourceSystem 分流 runtime / external-platform）、`ingressProtocols`、`appCallerCodes`。
一把 purpose 或协议不匹配的密钥仍会被清单当成「可用」，用户点进 Quickstart 才会被拒。

**为什么没做**：把整张授权矩阵抄进 TS 就是判据分裂（`predicate-and-wiring-discipline`
形状 3），必然随服务端演进漂移。正解是服务端出一个 onboarding digest 端点，直接复用
serving 的判定 —— 但 `llmgw/console-api` 与 `llmgw/serving` 是两个独立 csproj，
console-api 不引用 serving，要复用得先抽一个共享判定项目。属独立改动。

## ONB-key-page-cap — 密钥列表 500 条上限会影响新人清单的两个事实

**状态**：open（边界已知，触发条件极窄）

`GET /gw/service-keys`（`llmgw/console-api/Program.cs`）按 `CreatedAt` 倒序 `Limit(500)`。
轮换过 500 把以上密钥的租户，若**最新 500 把全部被吊销/禁用**而更早的那把仍启用，
或唯一带 `lastUsedAt` 的记录落在 500 条之外，清单会把「签一把密钥」「跑通首条请求」
两步误判成未完成 —— 已上手的老租户会看到清单重新出现。

**为什么没做**：客户端拿不到分页之外的数据，没有不新增端点的修法。正解与
ONB-key-usability 同一个：服务端 onboarding digest（用存在性查询，不受分页影响）。
两条应当一并解决。

影响面：新人清单是提示性 UI，误判的后果是多显示一个步骤，不影响任何实际能力。

## ONB-everused-preflight — 「跑通首条请求」会被 preflight 提前点亮

**状态**：open（方向保守，影响面窄）

`GatewayRuntimeGovernance.cs` 对**任何通过授权的 scope** 都无条件写 `LastUsedAt`，
紧接着下一行才用 `IsBusinessInvocationScope` 区分「只有 invoke / stream:invoke /
raw:invoke 才算业务流量」。新人清单的 `everUsed` 取自 `lastUsedAt`，所以一次
readiness 或 route preflight（例如自动化探针）就会把「跑通首条请求」点亮，
而租户其实还没发过一条真请求。

**为什么没做**：客户端没有可读的「仅业务调用」持久标记。请求日志有，但默认只留
90 天——正是因为这个才从日志改成了 `lastUsedAt`（见上文 everUsed 的注释）；
`RecordSuccessorObservationAsync` 写的是轮换后继观测，不是通用的「首次业务调用」。
要做就得服务端落一个持久标记并出 digest，与 ONB-key-usability / ONB-key-page-cap
是同一个改动。

**误判方向是保守的**：`lastUsedAt` 只会让这一步**提前**变完成，不会让已完成的
倒回未完成。清单是提示性 UI，提前消失的后果是少一次提示，不影响任何能力；
同 session 内刚跑成功的情况另有 `markRequestCompleted` 本地确证兜住。

---

## 相关

- 根 `CLAUDE.md` 规则 #11 —— 预览地址只能来自 CDS API，禁止本地推算
- `.claude/rules/no-rootless-tree.md` —— 缺席要可声明，不假定不存在的能力
- `.claude/rules/predicate-and-wiring-discipline.md` 形状 3 —— 63 判据此前分裂在三处，本轮收敛
- `cds/src/services/preview-slug.ts` —— slug 计算 SSOT（含 v1/v2/v3 沿革）
- `cds/tests/services/preview-entrypoints.test.ts` —— 入口表守卫（含 67 字符现场用例）
