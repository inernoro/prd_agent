# LLM 网关（GW）用户愿景与交接 · 计划

> **版本**：v1 | **日期**：2026-07-02 | **状态**：开发中（point 1/2 落地，point 3/4 待接力）
>
> 本文是「网关 GW」这条线的**交接 SSOT**：把用户 2026-07-02 明确的四点愿景，映射到当前状态与剩余工作，
> 让下一个智能体（或新 session）无需重新摸索即可接力 point 3（OpenRouter 风格控制台）与 point 4
> （全面用网关替换项目里所有模型请求）。point 4 的分阶段执行细节见 `plan.llm-gateway.full-cutover.md`（不重复）。

---

## 一、用户 2026-07-02 四点愿景（原话 + 解读）

1. **两个 web、两个域名、一主一副**：prdagent-admin 与 gw 拆成两个独立前端、两个独立命名域名，一主一副。
   域名规则见 `CLAUDE.md` 规则 #11（v3：`{tail}-{prefix}-{project}.miduo.org`）+ CDS 命名子域
   `<previewSlug>-<subdomain>.<root>`。
2. **GW 简单清晰的账号密码**：实在不行内置初始 `admin/admin`，登录进去再改。**不要** fail-closed 的复杂环境变量编排。
3. **GW 的 web 操作页面与 OpenRouter 一致**：清晰的观测/日志操作台（Activity/Generation 风格）。
4. **GW 能替换项目中所有对模型的请求**：解耦——MAP 侧所有 LLM 调用都走网关，去掉直连/耦合。

---

## 二、当前状态（本 session 已落地）

### Point 1 — 两个 web / 两个域名 / 一主一副：**已达成（结构层）**
- 部署了独立网关控制台容器 **`llmgw-web`**（`prd-llmgw-web`，nginx 托管 SPA + 反代 `/gw/*` → `llmgw:8090`）。
- CDS 分支详情面板已「多出口」：**主应用入口**（`main-prd-agent.miduo.org`）+ **网关控制台**
  （`main-prd-agent-llmgw-web.miduo.org/`，真实页面）+ **网关引擎·健康**（`llmgw` `/gw/healthz`、
  `llmgw-serve` `/gw/v1/healthz`）。预览按钮默认主入口，网关入口并列。
- prd-agent-main 现 **5 容器**：api / admin / llmgw / llmgw-serve / llmgw-web。

### Point 2 — 简单账号密码：**已达成（PR #978 + 首登强制改密 2026-07-02）**
- 后端 `prd-llmgw/Program.cs` 缺省内置 **admin/admin**，开箱可用；不再因未配 `LLMGW_ADMIN_PASSWORD`
  而拒启动（仅告警）。
- `SeedAdminAsync` 改 **upsert**（配置口令变化即对齐，`Verify` 判定、带盐哈希不空写）+ **禁用用户名≠当前
  配置的历史账号**（防改名后旧账号仍可登）。
- 改口令方式：在「项目设置 → 项目环境变量」设 `LLMGW_ADMIN_PASSWORD`（CDS 注入容器）→ 重新部署 llmgw → upsert 生效。
- **坑（Codex P1 · env，已规避）**：compose 里 **不要**写 `LLMGW_ADMIN_*: "${KEY:-default}"`——CDS
  `resolveProfileRuntimeEnv` 对 profile.env 自引用只在值恰好等于 `${KEY}` 时才还原项目变量，带 `:-default`
  会解析成字面量覆盖用户配置。缺省交给后端 admin/admin，改口令走项目环境变量注入。

#### Point 2 安全权衡：admin/admin 公网暴露 vs 用户「登录进去再改」（Codex P1 · 安全）

- **矛盾**：Codex 评审指出「网关控制台公网可达（`*-llmgw-web.miduo.org`），缺省 admin/admin 相当于把
  `/gw/logs` 观测数据对任何人开放」，建议生产 fail-closed 强制口令。但用户 point 2 **明确要求**
  「实在不行就内置初始 admin/admin，登录进去再改」，并否决了上一版 fail-closed 环境变量编排。
- **裁决（产品优先，用户拍板）**：**保留 admin/admin 开箱可用**（满足 point 2），生产以
  `Console.Error` 告警（已实现），并把 Codex 的安全顾虑落成**待接力的强约束**：
  **首登强制改密（force-change-on-first-login）**——这正是用户原话「登录进去再改」的正确工程化，
  既不牺牲开箱体验，又消除「永久 admin/admin 公网裸奔」。
- **已实现（point 2 收尾，2026-07-02）**：首登强制改密全链路落地，消除「公网 admin/admin 永久裸奔」。
  1. `LlmGwUser` 加 `MustChangePassword`（bool）；缺省弱口令（admin/admin）种子账号置 true，
     运维显式配置 `LLMGW_ADMIN_PASSWORD` 的账号视为已知口令、不置标记。
  2. `SeedAdmin` 分两模式：**默认模式**（未配口令）已存在账号**不回退**口令（库为权威，防重启抹掉用户改的密码）、
     仅确保启用；**配置模式**每次启动把口令对齐到 env 值并清标记。
  3. `/gw/auth/login` 返回 `mustChangePassword`；JWT 在该标记为 true 时带 `mcp=1` claim。
  4. **服务端策略门**（不只前端）：`LogsRead` 授权策略拒绝 `mcp=1` 的 token 访问 `/gw/logs*`，
     确保改密前无法真正读观测数据。改密端点走普通鉴权（允许 mcp token）。
  5. 新增 `/gw/auth/change-password`（校验旧口令→新口令≥6 位且≠旧→写新哈希→清标记→**重签发**不带 mcp 的 token）。
  6. 前端 `ChangePasswordPage` + `RequireAuth`/`RequireChangePassword` 守卫：`mustChangePassword` 时强制跳改密页。
  - 运维仍可用项目环境变量 `LLMGW_ADMIN_PASSWORD` 顶掉缺省口令（此时不触发强制改密）。
- **验证状态（2026-07-02，诚实记录）**：前端 `pnpm tsc -b` 零错误（已验证）；**后端运行时验证被 CDS
  平台基建阻塞**——`cdscli deploy` 两次均失败：① 首次报 `all predefined address pools have been fully
  subnetted`（CDS 宿主 Docker 网络地址池耗尽，创建分支网络失败，发生在编译/构建阶段**之前**；CDS 自动
  回收「已清理 0 个空闲分支网络」= 无安全余量可回收，且回收他人预览分支违反 cross-project-isolation）；
  ② 重试时 `GET /api/branches` 30s 超时（CDS 宿主 API 降级）。本沙箱无本地 dotnet SDK、无本地 docker
  daemon，无法离线编译 `prd-llmgw`。**待 CDS 基建恢复（扩容 Docker `default-address-pools` 或回收
  僵尸分支网络）后**，redeploy prd-agent-main（或本分支预览）即可完成后端首登强制改密全链路取证：
  login {admin/admin} → mustChangePassword=true → mcp token 访问 `/gw/logs` 应 403 → change-password
  → 重签发 token 读日志成功 → 重启 llmgw 不回退已改口令。

### Point 3 — OpenRouter 风格控制台：**部分（骨架在，需对齐设计）**
- `prd-llmgw-web` 已有：`LoginPage` / `LogsPage` / `LogsView`（请求日志表）/ `GenerationDetailsDrawer`
  （单条 generation 详情，OpenRouter Activity 风格）/ `MiniBarChart`（时序）。后端 `/gw/logs` `/gw/logs/{id}`
  `/gw/logs/timeseries` `/gw/logs/sessions` `/gw/logs/meta` 已就绪。
- **待接力**：与 OpenRouter 逐屏比对补齐（Activity 表列/筛选、Generation 详情字段：tokens/cost/latency/
  finish_reason/native tokens、模型维度聚合、时间窗切换、深色主题 token 一致）。属**前端设计打磨**，非架构。

### Point 4 — 全面用网关替换所有模型请求：**未做（仅安全基座）**
- 已有：观测标记（`GatewayTransport` inproc/http/shadow/direct）、影子比对（`ShadowLlmGateway` 落
  `llmshadow_comparisons`）、直连守卫棘轮（`GatewayDirectClientRatchetTests`）、no-key 401 契约测试。
- **未做**：把 MAP 所有 LLM 调用真正翻到网关（`LlmGateway:Mode=http`）+ 删 inproc/legacy 直连。这是
  `plan.llm-gateway.full-cutover.md` 的 **S5/S6**，**evidence-gated**（先看影子比对逐字段一致再灰度翻）。

---

## 三、Point 4 剩余直连清单（棘轮 baseline，接力起点）

`GatewayDirectClientRatchetTests.Baseline`（`prd-api/tests/PrdAgent.Tests/`）当前登记的「未走网关」直连：
- `Program.cs`=6（ILLMClient 工厂 legacy 三级兜底）
- `ModelDomainService.cs`=2（按用途取客户端；收口需网关支持 per-model maxTokens 入口）
- `ModelLabController.cs`=4 / `ArenaRunWorker.cs`=2（**故意直连**：测 admin 选中的 platform+model、绕池；
  走池会破坏「选 A 测 A」。需网关支持 pinned platform+model 入口后才能收口）

**收口顺序建议**：A 类（Program.cs / ModelDomainService）行为保持地改走 `gateway.CreateClient`（保留
temperature/凭据兜底/per-model maxTokens——上次天真收口丢了这些被 Bugbot 拦，见 #971 教训）→
B 类（ModelLab/Arena）等网关加 pinned 入口 → 翻 http（灰度 allowlist）→ 删 inproc/legacy。

---

## 四、关键文件 / 架构（接力必读）

| 关注点 | 位置 |
|---|---|
| 网关控制台前端 | `prd-llmgw-web/`（Vite React，`nginx.conf` 反代 `/gw`→`llmgw:8090`，运行时 DNS resolver） |
| 网关控制台后端 | `prd-llmgw/Program.cs`（独立 ASP.NET，`/gw/auth/login` + `/gw/logs*`，SeedAdmin upsert） |
| serving 引擎 | `prd-api/src/PrdAgent.LlmGateway/`（`/gw/v1/*`，X-Gateway-Key 门） |
| CDS 预构建镜像 app 站点识别 | `cds/src/services/compose-parser.ts` `isAppServiceCandidate`（image+cds.prebuilt-image+subdomain） |
| CDS 裸别名（llmgw-prd-agent→llmgw） | `cds/src/services/container.ts` `computeProfileAliases`（剥离完整项目 slug 后缀） |
| 落地路径 / 面板 | `cds/src/routes/branches.ts` `resolveGatewayLandingPath` / `computeBranchGatewayUrls`；`cds/web/src/components/BranchDetailDrawer.tsx` |
| compose | `cds-compose.yml`（llmgw / llmgw-serve / llmgw-web 三服务；llmgw-web 是 prebuilt 镜像 app 站点） |
| 切换 SSOT | `doc/plan.llm-gateway.full-cutover.md` |

**已踩的坑（别重犯）**：① CDS compose 解析器原先只认「源码 mount / build:」为 app service，纯 image 站点会被
静默丢弃；② 纯 nginx 站点 `proxy_pass http://llmgw:8090` 必须用 `resolver 127.0.0.11 + 变量 upstream`
运行时解析（否则启动缓存 IP → 竞态/换 IP 502）；③ 导入/配置校验对 prebuilt profile 要豁免 command
必填；④ `${KEY:-default}` 自引用会被 CDS 覆盖成字面量（见 point 2）；⑤ CDS `branch exec` 输出对机密
做掩码，读环境变量判空不可靠。

---

## 五、接力下一步（point 3 / 4）

**Point 3（前端打磨，低风险）**：以 OpenRouter Activity/Generation 为参照，逐屏补齐 `prd-llmgw-web`
`LogsView`/`GenerationDetailsDrawer` 的列/筛选/聚合/主题；无需动 CDS/后端架构。改 `prd-llmgw-web/**`
会触发 CI 重建 `prdagent-llmgw-web` 镜像，redeploy prd-agent-main 即生效。

**Point 4（高风险，evidence-gated）**：严格按 `plan.llm-gateway.full-cutover.md` 的 S3-A→S3-B→S5→S6
推进；每步先跑影子比对（`/gw/v1/shadow-comparisons`）确认 inproc vs http 逐字段一致，再灰度 allowlist
翻 http，最后删 inproc/legacy。**禁止**一把梭翻 http + 删兜底（会让全站 LLM 依赖刚起的 serving 进程）。

---

## 六、关联文档

- `doc/plan.llm-gateway.full-cutover.md` — point 4 分阶段执行 + MECE 矩阵 + 遗漏 + 风险（SSOT）。
- `CLAUDE.md` 规则 #11（预览域名公式）、#9（导航登记）、`.claude/rules/llm-gateway.md`（所有 LLM 调用走 Gateway）。
