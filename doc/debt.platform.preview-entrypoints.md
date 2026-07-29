# 预览入口下发（Preview Entrypoints）· 债务台账

> **版本**：v1.0 | **日期**：2026-07-29 | **状态**：开发中

## 总览

当前 open: 4（PE-transition-window / PE-env-staleness / PE-consumer-sweep / PE-llmgw-console-mapnav）/ 已落地待验证: 4（PE-ssot-inversion / PE-truncation / PE-console-subdomain-rename / PE-truncation-readability）/ 总计: 8

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

### PE-consumer-sweep · 其他消费方尚未清查 —— open

本轮只收敛了模型网关控制台这一个消费方（3 处调用点：`AppShell` / `CompatibilityStack` /
`DocumentStorePage`）。仓库里是否还有别处按 hostname 推算兄弟服务地址，尚未做全量扫描。

守卫现状：`prd-admin/src/lib/__tests__/llmGatewaySso.test.ts` 有一条源码守卫，
禁止 `llmGatewaySso.ts` 里再出现 `miduo.org` / `hostname` / `63`。这只锁住了这一个文件，
不是全仓禁令。

补法：加一条全仓守卫，扫 `prd-admin/src`、`llmgw/web/src` 里的
`` `${...}.miduo.org` `` 模式与 `-llmgw-web` 字面量，白名单显式登记。

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

### PE-llmgw-console-mapnav · 控制台反推 MAP 地址是第三份域名实现 —— open

`llmgw/web/src/lib/mapNavigation.ts` 的 `resolveMapHomeHref` 按 `location.hostname`
剥掉控制台子域后缀来推 MAP 主入口地址 —— 与 MAP 侧刚拆掉的那份同源。它此前硬编码
`-llmgw-web` 单一后缀，子域一改名就会失效（返回控制台自己的根路径，「返回 MAP」
和「教程」深链一起断）。

本轮先把「认哪些后缀」收敛成文件内唯一一处 `CONSOLE_SUBDOMAIN_SUFFIXES`（新旧都认），
止住改名带来的破坏。**正解仍未做**：console-api 读平台注入的 `CDS_PREVIEW_URL`
（分支主入口 = MAP）下发给 SPA，本文件只消费。与 PE-consumer-sweep 同批清理。

---

## 相关

- 根 `CLAUDE.md` 规则 #11 —— 预览地址只能来自 CDS API，禁止本地推算
- `.claude/rules/no-rootless-tree.md` —— 缺席要可声明，不假定不存在的能力
- `.claude/rules/predicate-and-wiring-discipline.md` 形状 3 —— 63 判据此前分裂在三处，本轮收敛
- `cds/src/services/preview-slug.ts` —— slug 计算 SSOT（含 v1/v2/v3 沿革）
- `cds/tests/services/preview-entrypoints.test.ts` —— 入口表守卫（含 67 字符现场用例）
