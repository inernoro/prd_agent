# 预览入口下发（Preview Entrypoints）· 债务台账

> **版本**：v1.0 | **日期**：2026-07-29 | **状态**：开发中

## 总览

当前 open: 4（PE-truncation / PE-transition-window / PE-env-staleness / PE-consumer-sweep）/ 已落地待验证: 1（PE-ssot-inversion）/ 总计: 5

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

### PE-truncation · 超长分支仍然拿不到网关入口 —— open

`capPreviewSlug`（`preview-slug.ts:53`，截断到 54 字符 + `-` + sha1 前 8 位）目前只作用在
previewSlug **本身**（293/301/309 三处），没有作用在复合标签 `${previewSlug}-${sub}` 上。
超长时命名子域是**跳过不发布**，不是截断。

现状影响已从「拼错域名」降级为「明确告知没有入口」——正确性问题已解，剩下的是可用性：
长分支名的预览环境点不开网关控制台。

补法（独立排期）：把 cap 提到复合标签这一层，发布端（`forwarder-route-publisher`）、
`computeBranchGatewayUrls`、`preview-entrypoints` 三处同时改（它们已共用
`isPublishableNamedLabel` 判据，改一处判据即可）。**必须保留哈希后缀** ——
纯截断会丢唯一性、可能与别的 slug 撞 host（发布端注释里原本拒绝截断就是这个理由）。

绕过办法（当下）：用更短的分支名重新部署，或在正式域名上打开。

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

---

## 相关

- 根 `CLAUDE.md` 规则 #11 —— 预览地址只能来自 CDS API，禁止本地推算
- `.claude/rules/no-rootless-tree.md` —— 缺席要可声明，不假定不存在的能力
- `.claude/rules/predicate-and-wiring-discipline.md` 形状 3 —— 63 判据此前分裂在三处，本轮收敛
- `cds/src/services/preview-slug.ts` —— slug 计算 SSOT（含 v1/v2/v3 沿革）
- `cds/tests/services/preview-entrypoints.test.ts` —— 入口表守卫（含 67 字符现场用例）
