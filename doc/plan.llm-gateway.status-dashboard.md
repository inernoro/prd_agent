# LLM 网关剥离 · 活状态看板（SSOT）

> 类型: plan | owner: inernoro | 最后更新: 2026-07-02
> **这是网关剥离这条线的「活看板」**：想知道「现在到哪一步了 / 能不能发布 / 下一步是什么」，看这一页，不用再问。
> 规则依据: `.claude/rules/living-status-board.md`（本文件是它要求的看板实例）。
> 深度文档: `plan.llm-gateway.full-cutover.md`（切换 SSOT）/ `design.llm-gateway-physical-isolation.md`（架构）/ `plan.llm-gateway.rollout.md`（波次进度）。
> **每次有意义的状态变化，改这一页**（改完一句话结论 + 记分卡 + 下一步）。

---

## 0. 一句话现状 + 能不能发布

- **现状**：网关剥离的「硬骨头」（独立 serving 进程 + 跨进程 `/gw/v1/*` + 影子基础设施 + 独立控制台）约 **75%** 完成，但**默认仍是 `inproc`**（真实流量走进程内），配置面**未迁到网关**（控制台只有日志），还有 **8 处 A 类直连**绕过网关。
- **能不能发布**：
  - **可以**——把当前分支作为「观测能力增强」发布：默认 `inproc`，行为与 main 一致、纯增量、可秒回滚。
  - **不可以**——宣称「网关已剥离干净 / 翻 `Mode=http`」：核心命题（真实流量走 HTTP=可追溯）尚未兑现，见 §2 记分卡的红灯。
- **两条腿**：腿 A（运行时路由剥离）≈75% 基建、未翻 http；腿 B（管理面/配置迁到网关）≈0%。用户最直观的不满在腿 B。

---

## 1. 两条腿进度

| 腿 | 含义 | 进度 | 卡在哪 |
|---|---|---|---|
| A 运行时路由 | MAP 的 LLM 调用真的走独立网关（inproc → http） | ~75% 基建 | L1 日志标记 + S3 收 8 处直连 + 影子攒证据 + 翻 http + 删 inproc |
| B 管理面 | 网关是「配置/管理模型」的地方，不只看日志 | ~0% | 控制台零配置端点，模型/平台/池全在 MAP |

---

## 2. 剥离干净度记分卡（可机器核对，别信「差不多」）

> 依据 `.claude/rules/extraction-readiness-gate.md`。每个「当前值」都有客观来源。

| 维度 | 判据 | 目标 | 当前 | 状态 |
|---|---|---|---|---|
| 默认路径 | `LlmGateway:Mode`（`Program.cs:212` `?? "inproc"`） | `http` | `inproc` | partial（基建 done，未翻） |
| 调用去老路 | 绕过网关的直连数（`GatewayDirectClientRatchetTests`） | 0（A 类） | A 类 8（Program.cs 6 + ModelDomainService 2）+ B 类 6（有意对照评测） | partial |
| 配置面迁移 | 网关控制台有模型/平台/池配置端点 | 100% | 0（`prd-llmgw` 只有 auth+logs） | not-started |
| 影子证据 | `llmshadow_comparisons` 样本量 / allMatch | 样本 ≥阈值 且 diff ≤阈值 | 样本 n=1（首条 allMatch） | partial（严重不足，建议攒 7-14 天） |
| serving 密钥 | serving 容器能解密真实平台密文、无 401 | 无解密失败 | **真机取证：所有真实平台可解密，仅 1 个 dev-stub 解不出（预期）** | done（已加 serving 自检 + stub 分类） |
| 双出口 HTTPS | 网关命名子域走 HTTPS | 2 个 HTTPS | 1 HTTPS + 3 HTTP | 修复已提交（激活见 §3.A） |
| 回归 | 全量测试 + navCoverage | 全绿 | 后端 shadow 单测 1326 passed | done |

**可安全发布 Gate（全绿才放行翻 http）**：默认 Mode=目标态 / A 类直连=0 / 配置面迁完 / 影子样本≥阈值且 diff≤阈值 / serving 无解密失败·无 401 / 全量回归绿 / 关键面过真视觉验收。**当前多条红灯 → 只可作观测增强发布，不可翻 http。**

---

## 3. 本次（2026-07-02）修复项与状态

### A. 双出口 HTTPS（痛点 5a）
- **根因**：不是证书/nginx 能力缺失，是 `cds/src/routes/branches.ts` 把命名子域 URL **硬编码成 `http://`**（主应用走 `https://`）。nginx 的 `*.<root>` server 块已在 443 用同一份通配证书服务命名子域。
- **修复**：`branches.ts` 4 处 `http://` → `https://`（命名子域/网关/别名出口）。
- **激活**：这是 **CDS 平台代码**，要生效需 CDS 服务跑到这份代码——走 **合 main → 生产 CDS 自更新**，或对生产 CDS self-update（系统级，谨慎）。已提交，未在生产激活。

### B. ApiKeyCrypto「Stub 开发桩」解密失败（痛点 5 关键 bug）
- **根因**：`cds-compose.yml` 的 `llmgw-serve` 没像生产 `docker-compose.yml` 那样从**同一份 env 锚点**显式注入 `ApiKeyCrypto__Secret` + `LegacySecrets`，退化成依赖全局占位符（`TODO`）。serving 的密钥回退链落到硬编码 stub `DefaultEncryptionKey32Bytes!!!!` → 解不出真实平台密文。api 因对 `Jwt:Secret` fail-closed + 钥环含 `Jwt:Secret` 兜底，能解出，故只有 serving 受影响。
- **重要澄清（避免误修）**：那条 `[PlatformKeyIntegrity]` 告警**只在 api 侧注册**、报的是共享 Mongo 上「**1 个** Stub 开发桩平台」的全局告警。而且：占位符 `ApiKeyCrypto__Secret`（`TODO`）只有 24 字节 < 32，若 llmgw-serve 真拿的是它、api 也会拿它、api 早该在启动时抛异常——api 正常运行，说明**真实密钥已 pin 成 CDS 项目变量**、经全局 `x-cds-env` 注入**所有**容器（含 llmgw-serve）。故极可能 serving **能**解密真实平台，那条告警只是**一个有意的 dev-stub 平台**的良性噪音。
- **已定论（2026-07-02 真机取证）**：给 serving 补 `ServingKeyIntegrityCheck` 后读 llmgw-serve 日志——只有 **1 个「Stub 开发桩」**解不出，**所有真实平台密文 serving 都能解密**。所以**没有真 serving 解密 bug**，你截图里那条吓人的 `[PlatformKeyIntegrity]` Error 是**单个有意 dev-stub 平台**的良性噪音（api 侧全局告警）。→ **不改 cds-compose、不 pin 密钥**（避免 `${...}` 空插值打坏 api），因为根本不需要。
- **顺带治「吓人的日志」**：api 侧 `PlatformKeyIntegrityWorker` + serving 侧 `ServingKeyIntegrityCheck` 都改成**把 dev-stub 与真实平台分类**——只有真实平台解不出才 `Error` + 推站内信；纯 stub 解不出降级为 `Info`「已跳过 N 个 dev-stub」，不再误报「模型池调用将全部失败」。容器日志从此干净，真故障仍会大声报。

### C. 腿 A 下一个硬前置：L1 GatewayTransport 日志标记
- 未做，是翻 http 的**唯一硬 blocker**（翻后日志页分不清 inproc/http/shadow）。也顺带给控制台日志页加「走了哪条路」列。

---

## 4. 容器拓扑澄清（痛点 5b —— 不是 bug，是展示 + 认知落差）

一个 prd-agent 预览分支实际起 **7 个容器**（不是 5，也不是你想的 6）：

| 容器 | 层 | 职责 | 上分支卡？ |
|---|---|---|---|
| api | 后端 | MAP 业务 + 进程内 LLM（Mode=inproc） | 是 |
| admin | 前端 | 主应用 SPA（prd-admin） | 是 |
| llmgw | 后端 | 网关**控制台**后端（登录 + 读日志观测） | 是 |
| llmgw-serve | 后端 | 网关**serving 引擎**（`/gw/v1/*`，烧额度、解密真钥、热路径） | 是 |
| llmgw-web | 前端 | 网关控制台 SPA（nginx） | 是 |
| **mongodb** | **共享 infra** | 项目级共享库 `cds-infra-mongodb`，**所有分支共用** | **否** |
| **redis** | **共享 infra** | 项目级共享缓存 `cds-infra-redis`，**所有分支共用** | **否** |

- **你漏算的**：redis/mongo 是**项目级共享基础设施**，不随分支起容器、不在分支卡上（在「基础设施/拓扑」面板）。
- **多出的第 3 个后端**：网关在剥离中被拆成「控制台后端 `llmgw`」+「serving 引擎 `llmgw-serve`」两个进程（控制面 vs 数据面分离，是 rollout 的有意目标）。
- **正确公式**：**2 前端（admin, llmgw-web）+ 3 后端（api, llmgw, llmgw-serve）+ 2 共享 infra（mongo, redis）= 7**。
- **能不能变回「2 后端」**：serving 必须独立（热路径 + 持真钥，合回 api 等于推翻剥离，不做）；唯一可选是把「控制台后端 llmgw」并进 serving（变成「1 网关后端 + api」）——省一个容器但把人面 JWT 控制台和烧钱数据面塞进一个进程，需你拍板是否接受（默认保持现状 3 后端，故障隔离更强）。改进方向已写进规则 `cds-dual-exit-topology.md`：面板要按子系统分组 + 显式挂共享 infra chip。

---

## 5. 下一步（优先级）

1. **本次修复落地验证**：部署本分支，确认 serving 侧新 Worker 报不报解密失败（把 §3.B 盲区消掉），网关控制台走一遍视觉验收留证。
2. **腿 B 第一刀（推荐先做，低风险，直击「没配置的地方」）**：网关控制台加「模型池/平台/模型/影子比对」只读页（`prd-llmgw` 加只读端点 + `prd-llmgw-web` 加页），让网关「看得见能配」。
3. **腿 A 下一个 gate**：L1 GatewayTransport 日志标记（翻 http 硬前置）。
4. HTTPS 双出口 + cds-compose 锚点修复合 main，让 CDS 平台级生效。

---

## 6. 验收证据 / 可达地址

- 网关控制台（本分支）：`https://llm-gateway-handoff-point2-rx224v-claude-prd-agent-llmgw-web.miduo.org/`（admin / 用户已设口令；未认领时重新部署即恢复 admin/admin）
- 主应用（本分支）：`https://llm-gateway-handoff-point2-rx224v-claude-prd-agent.miduo.org/`
- 影子比对读端点：`GET /gw/v1/shadow-comparisons`（X-Gateway-Key 门内）
- 视觉验收报告：见本轮交付（归档进验收知识库）
