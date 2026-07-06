# LLM 网关全面切换执行计划 · 计划

> **版本**：v1 | **日期**：2026-07-01 | **状态**：规划中
>
> 用户 2026-07-01 四点诉求：① 全面撤销 MAP 的 AI 直接调用，全部走网关；② 删除 MAP 里所有网关相关旧代码（避免回归），配置全延伸到网关；③ 全面 MECE 测试所有接口，保存进项目供第三方复测；④ 检查最终遗漏。外加 point 0：CDS 多出口面板（分支详情显示多个命名入口 + 预览按钮默认主入口）。
> 本文是这次全面切换的 SSOT：根因、分阶段执行、MECE 测试矩阵、遗漏清单、风险。由 6-agent 调研工作流取证合成（2026-07-01）。

---

## 0. Point 0 — CDS 多出口面板（根因 + 修复）

**根因是"数据链路断裂"，不是没做**：
1. `forwarder-route-publisher.ts:285-315` 已按 `cds.subdomain` 标签生成 `<previewSlug>-<sub>.<root>` 命名路由，写进 `forwarder-routes.json`（网关 URL 已发布）。
2. 但 `GET /api/branches/:id/subdomain-aliases`（`branches.ts:12689-12711`）只回 `aliases`（手动）/`previewUrls`/`defaultUrl`，**读不到容器 `cds.subdomain` 标签** → 网关命名 URL 从未回流到 API。
3. 前端 `BranchDetailPage.tsx:1543/1547` 只渲染 `defaultUrl` + 手动别名 → 网关命名 URL 在面板隐身。
4. 叠加**生产 CDS v0.7.1（buildTime 2026-06-26）落后命名子域特性 ~5 天** → 缺 DNS 守卫/去重/删除逻辑，需 self-update。

**修复（S1 + S0）**：扩展端点回 `gatewayUrls` 字段（读 `cds.subdomain`，走 `computePreviewSlug` SSOT）+ 前端加「网关入口」分组 + 「预览」默认主入口、下拉「打开网关」+ 生产 CDS self-update。

---

## 1. 分阶段执行计划（低风险先行；翻 http/删 inproc 必须被 MECE 测试 gate）

### 1.1 目标数据域（2026-07-04 新裁决）

Point 4 的“全面走网关”不等于“MAP 日志归 GW 管”。目标边界如下：

- **MAP 继续负责自己的日志**：MAP 业务流程、页面、Agent run、管理后台调试所需日志继续落 `prdagent`，由 MAP 自己消费。
- **LLM Gateway 负责自己的日志**：GW 控制台账号、登录审计、操作审计、GW serving 请求日志、shadow 对账证据落独立数据库 `llm_gateway`。
- **控制台账号不再由 env 长期托管**：`LLMGW_ADMIN_PASSWORD` 只能用于 bootstrap/破玻璃，长期口令权威必须是 `llm_gateway.llmgw_console_users`。
- **切网关后的双视角是设计目标**：MAP 侧可以看到“业务调用发生了什么”，GW 侧看到“模型网关如何解析、转发、失败、降级、计费/耗时”。两者用 requestId/sessionId/appCallerCode 关联，不互相吞并。

这条边界优先于下文早期“共享 Mongo 混入其它分支日志”的旧风险描述；旧风险仍成立，但解决方式是**独立 GW 数据库 + 关联 ID**，不是把所有日志混成一个集合。

| 阶段 | 目标 | 风险 | 关键改动 | 验证 |
|---|---|---|---|---|
| **S0.5** GW 数据域隔离 | GW 账号/审计/网关日志落 `llm_gateway` | 中 | `prd-llmgw` 账号库切 `llm_gateway`；登录审计落 `llmgw_login_audits`；serving 日志 writer 支持 GW DB；env 口令仅 bootstrap/破玻璃 | `admin/admin` 首登改密后重启不被 env 覆盖；MAP 日志仍留 MAP；serving 请求日志与 shadow 证据写 `llm_gateway` |
| **S0** 前置解阻 | 清 self-update + serving 常驻 blocker | 中 | 批准 cds-compose 拓扑导入 + 生产 CDS self-update（先 dry-run）+ serving 项目级常驻 | 命名子域可见 + serving 稳定 |
| **S1** CDS 面板出口可见性 | 网关命名 URL 回流并在面板渲染（point 0） | 低 | `branches.ts` 端点加 `gatewayUrls` + `BranchDetailPage.tsx` 加「网关入口」分组 + `openPreview` 加「打开网关」+ `resolveApiLabel` 补 label | 面板同显主应用+网关两组 URL；双主题；navCoverage/api-label 无 warning |
| **S2** L1 观测 | 日志页辨 inproc/http（翻 http 硬前置） | 低 | 已落地：`GatewayTransport` 每条 llmrequestlog 标 inproc/http/direct，控制台支持筛选/汇总 | 日志页可筛 transport |
| **S3** 六处直连收口 | ModelLab/Arena/ModelDomainService/Program.cs 全改走 ILlmGateway（point 1 核心） | 中 | 已收口，`GatewayDirectClientRatchetTests` baseline 为空；后续靠棘轮防回退 | grep 守卫 0 直连 + 集成测试 |
| **S4** multipart raw HTTP 化 | 生图/ASR 内联文件 http 兜底 | 中 | `HttpLlmGatewayClient` MultipartFileRefs 对象存储 rehydrate | http 模式生图不 `MULTIPART_HTTP_UNSUPPORTED` |
| **S5** 灰度 canary 翻 http | 单入口 http 权威验证（flag 秒回滚） | 高 | `LLMGW_HTTP_APP_CALLER_ALLOWLIST=<低风险入口>`；发布前同样强制 release gate | 该入口 http 结果与 inproc 逐字段一致 |
| **S6** 全面翻 http + 删 inproc | `Mode=http` 全量 + 删进程内网关本体 + legacy 标记（point 1/2 终态） | 高 | 删 `LlmGateway.cs`/`ShadowLlmGateway.cs`/`FindLegacyModelAsync` | **必须被 S7 MECE 全绿 gate**；保留 revert commit 秒回 inproc |

> S5/S6 是用户最怕回归的部分：**前置 = shadow 证据积累 7-14 天 + serving HA + S7 测试全绿**。不满足不翻。

---

## 2. MECE 接口测试矩阵（point 3 · 交第三方复测）

| 接口/能力 | 类型 | 走网关 | 测试手段 | 断言 |
|---|---|---|---|---|
| GET /gw/v1/healthz | 网关-健康 | yes | curl（免 key） | 200 status ok + commit |
| POST /gw/v1/resolve | 网关-预解析 | yes | xUnit + 种子 | 解析到正确 model/档位/协议 |
| POST /gw/v1/send | 网关-非流式 | yes | xUnit + curl（需 key） | model 命中/内容非空/token |
| POST /gw/v1/stream | 网关-流式 SSE | yes | xUnit + curl SSE | 首字节 + 逐块 + [DONE] |
| POST /gw/v1/raw | 网关-原始代理 | yes | xUnit | 透传 body.model 不被覆盖 |
| POST /gw/v1/client-stream | 网关-跨进程 ILLMClient | yes | xUnit + shadow | 往返一致 |
| GET /gw/v1/pools | 网关-模型池 | yes | curl + xUnit | 返回真实池（DB 连通+解密） |
| GET /gw/v1/shadow-comparisons | 网关-影子对账 | yes | 集合查询 | inproc=http 0 critical |
| scripts/llmgw-release-gate.py | 发布证据门 | yes | healthz + shadow 汇总 | healthz 200、critical=0、httpFail=0、样本数达标 |
| ILLMClient DI 工厂 (Program.cs 969-1068) | MAP-直连收口 | should-migrate | grep 守卫 + 集成 | 0 直连 new Client |
| ModelDomainService.GetClientAsync (77/88) | MAP-直连收口 | should-migrate | 集成 + grep | 走网关 |
| ModelLabController.RunExperiment (436/537) | MAP-直连收口 | should-migrate | xUnit | 走网关 + 落 llmrequestlogs |
| ArenaRunWorker.ProcessSlot (444/445) | MAP-直连收口 | should-migrate | xUnit | 走网关 + 落日志 |
| POST /api/pa-agent/chat | MAP-Agent 聊天 | yes | xUnit + curl SSE | 流式正常 |
| CCAS 5 流式端点 (/api/ccas-agent/*) | MAP-Agent 聊天 | yes | xUnit x5 | 各端点流式 |
| POST /api/pr-review/stream | MAP-Agent 聊天 | yes | xUnit | 流式 + 心跳 |
| POST /api/visual-agent/image-gen/generate | MAP-生图 | yes | xUnit + 图校验 | 出图 + 无选A给B |
| POST /api/literary-agent/image-gen/run | MAP-生图(异步) | yes | xUnit | run 完成 |
| POST /api/visual-agent/video-gen/runs | MAP-视频(异步) | yes | xUnit | run 完成 |
| POST /v1/open-platform/chat/completions | MAP-OpenAI 兼容 | yes | Python OpenAI SDK + Postman | 兼容返回 |
| GET /api/app-callers | MAP-身份注册表 | n/a | curl + xUnit | 153 入口 |
| GET /api/platforms | MAP-平台配置 | n/a | curl + xUnit | 平台列表 |
| 多平台适配器 (Claude/OpenAI/Qwen/OpenRouter) | 网关-协议保真 | yes | xUnit + 真机 B 层 93 cell | think/tool/token/finish 保真 |
| LlmGateway:Mode 三态开关 | 网关-配置门 | n/a | 配置审查 + 集成 | inproc/http/shadow 正确路由 |
| GatewayTransport 日志标记 (L1) | 网关-观测 | n/a | 日志集合查询 | 每条标 transport |
| 访问控制 (X-Gateway-Key + 限流) | 网关-安全 | yes | xUnit + 日志 | 无 key 401 |
| GET /api/branches/:id/subdomain-aliases | CDS-出口可见性 | n/a | curl + vitest | 回 gatewayUrls |
| gw-smoke.py 真机冒烟 (D 层) | 网关-端到端真机 | yes | cdscli 部署后 | 10/10 + stream/client-stream + canary 必败 |

发布前证据门命令（S5/S6 必跑）：

```bash
GW_BASE=https://<preview-or-prod-llmgw-serve>/gw/v1 \
GW_KEY=<X-Gateway-Key> \
python3 scripts/llmgw-readiness-audit.py \
  --run-dotnet \
  --run-smoke \
  --run-serving-probe \
  --run-cds-runtime \
  --run-shadow-coverage \
  --require-release-gate \
  --min-total 30 \
  --health-samples 3 --health-interval 5 \
  --since-hours 24 \
  --min-coverage-hours 24 \
  --app-caller report-agent.generate::chat --min-per-app 30 \
  --require-kind send:30 \
  --require-app-kind report-agent.generate::chat:send:30 \
  --json-out /tmp/llmgw-readiness.json \
  --report-md /tmp/llmgw-readiness.md
```

`scripts/llmgw-readiness-audit.py` 是 S5/S6 发布前总 gate：静态检查 release gate/`exec_dep.sh`/compose/GW 数据域、
直连棘轮空 baseline、multipart HTTP rehydrate、回滚脚本 dry-run；传 `--run-dotnet` 时会跑关键 xUnit 守卫；
当前 `--run-dotnet` 覆盖直连/数据域、93-cell 协议保真、Claude 工具翻译、shadow/raw 对账、
multipart/key-gate/http-failure、C 层跨进程矩阵、serving 端点合同、Doubao ASR 与 OpenRouter 视频合同；
传 `--run-smoke` 时会调用 `scripts/gw-smoke.py` 真打 `/gw/v1/healthz`、`/pools`、`/send`、`/stream`、
`/client-stream` 与 canary 必败；
传 `--run-serving-probe` 时会调用 `scripts/llmgw-serving-probe.py` 连续探测 healthz commit 稳定性，
并确认 `/gw/v1/*` 受保护读端点未带 key 时返回 401，防止 serving 滚动中或鉴权裸奔时进入灰度；
传 `--run-cds-runtime` 时会调用 `cdscli branch status` 校验当前预览/灰度分支的网关运行形态：
`llmgw-prd-agent` 与 `llmgw-serve-prd-agent` 必须是 running 且 `deployedMode=express`，
commit 必须匹配 `--expect-commit`，`llmgw-web-prd-agent` 必须 running。这样可以防止“CI 镜像已绿，
但灰度仍在源码模式或旧容器上验证”的假阳性；
传 `--run-shadow-coverage` 时会调用 `scripts/llmgw-shadow-coverage-report.py` 输出 global/kind/appCaller×kind
覆盖矩阵，明确每个格子的 total、allMatch、critical、httpFail 与是否达标；传 `--expect-commit` 时矩阵默认只统计
该 commit 产生的 shadow 样本，防止旧版本证据搭车。
传 `--require-release-gate` 时会调用 `scripts/llmgw-release-gate.py` 检查真实 health/shadow 样本；release gate
同样会在 `--expect-commit` 或 `--shadow-release-commit` 存在时只统计该 commit 的 shadow 记录。

`exec_dep.sh` 也内置同一 live release gate：全量 `LLMGW_MODE=http` 或灰度 `LLMGW_HTTP_APP_CALLER_ALLOWLIST` 非空时
都会强制执行。这个 gate 分两段：`docker compose up` 前只用当前线上 serving 检查同 commit shadow 证据是否满足
critical/httpFail/样本/覆盖时长门槛；`docker compose up` 后再对新镜像运行 serving probe 与 D 层 smoke，
并在不可变 `--commit <sha>` 发布时要求 `/gw/v1/healthz` 的 commit 匹配该 sha。这样避免“新 commit 尚未部署，
发布前 healthz 却被要求等于新 commit”的假失败，也避免部署后漏验新 serving；同时避免不同 commit 复用旧 shadow 样本。缺少 `LLMGW_GATE_BASE`/`GW_BASE` 或
`LLMGW_GATE_KEY`/`GW_KEY`/`LLMGW_SERVE_KEY` 会拒绝部署；`LLMGW_MODE=shadow|inproc`
且 allowlist 为空时不挡发布，便于先以 shadow 积累证据。生产 compose 已透传
`LLMGW_HTTP_APP_CALLER_ALLOWLIST` 和 `LLMGW_SHADOW_FULL_SAMPLE_PERCENT`，避免灰度配置只停留在脚本层。
`.github/workflows/llmgw-shadow-watch.yml` 每 6 小时跑一次同一套 serving probe、shadow coverage 与 live
release gate；需要配置 `vars.LLMGW_PROD_GATE_BASE` 和 `secrets.LLMGW_PROD_GATE_KEY`。该 workflow 会上传
`readiness.json` / `readiness.md` 作为证据期归档，默认要求核心 appCaller、send/stream/raw、图片/视频/ASR
raw 入口样本达标，并且每格 shadow 样本覆盖至少 24 小时。
`.github/workflows/llmgw-prod-preflight.yml` 提供手动生产预检入口，支持 `start` 与 `completion` 两种模式；
需要配置 `vars.PRD_AGENT_PROD_BASE`、`vars.LLMGW_PROD_GATE_BASE`、`vars.LLMGW_PROD_EXPECT_COMMIT`、
`secrets.PRD_AGENT_PROD_API_KEY`（需 `logs:read`）和 `secrets.LLMGW_PROD_GATE_KEY`。该 workflow 会上传
`prod-preflight.json`，用于在执行 `shadow-start` 前证明 MAP 日志权限、GW health/key 和目标 commit 配置可用；
`completion` 模式还会把 rollout ledger 终态纳入检查，防止没有 `http-full` 成功台账时宣称完成。
`.github/workflows/llmgw-prod-stage.yml` 是正式阶段执行入口，默认跑在 `["self-hosted","prd-agent-prod"]`
生产 runner 且绑定 GitHub `production` environment；默认 `execute=false` 只做 dry-run，只有显式打开
`execute=true` 才会调用 `scripts/llmgw-prod-stage.sh --execute`。workflow 复用同一组生产 vars/secrets，
并把 `.llmgw-release-evidence/` 上传为 `llmgw-prod-stage-<runId>` artifact；执行成功后还会对当前阶段
调用 `scripts/llmgw-rollout-ledger.py audit --require-target-success` 生成 `stage-audit.json/md`。这样每个
shadow/canary/http/rollback 阶段都留下可下载、可复核、无密钥的 release-gate、serving-probe、gw-smoke、
stage report 与 rollout ledger 证据包，避免证据只存在某台生产机器本地。
正式发布如果先跑 `fast.sh --commit <sha>` 预热镜像，脚本会写入
`${PRD_AGENT_RELEASE_INTENT_FILE:-.prd-agent-release-intent.env}`，记录 api/llmgw/llmgw-serve/llmgw-web
四个镜像的同一 release ref；随后 `exec_dep.sh --commit <sha>` 会读取该 intent 并拒绝不同 commit/tag/repo 的部署。
生产可设置 `PRD_AGENT_REQUIRE_FAST_INTENT=1` 强制“先 fast 后 exec”；紧急人工绕过必须显式设置
`PRD_AGENT_IGNORE_FAST_INTENT=1` 并留下发布记录。

生产阶段推进统一走 `scripts/llmgw-prod-stage.sh`，避免人工拼 `LLMGW_MODE`、allowlist、canary stage 和
证据输出路径：

```bash
LLMGW_GATE_BASE=https://<prod-llmgw-serve>/gw/v1 \
LLMGW_GATE_KEY=<X-Gateway-Key> \
scripts/llmgw-prod-stage.sh --stage shadow-start --commit <40位SHA> --execute
```

支持阶段：`shadow-start`、`rollback-rehearsal`、`canary-intent-text`、`canary-chat`、`canary-streaming`、`canary-vision`、
`canary-image`、`canary-video-asr`、`http-full`、`rollback-inproc`。脚本默认 dry-run，只有显式
`--execute` 才会真实运行；deploy 阶段会先跑 `fast.sh --commit <sha>`，再用同一个 sha 跑
`exec_dep.sh --commit <sha>`，并默认设置 `PRD_AGENT_REQUIRE_FAST_INTENT=1` 与
`.llmgw-release-evidence/<time>_<stage>_<sha>.*.json|md` 证据输出。证据分四类：
`*.release-gate.*`（shadow 样本门）、`*.serving-probe.*`（health/401/commit 稳定）、
`*.gw-smoke.*`（D 层真机冒烟）、`*.stage.*`（阶段汇总）。脚本不接受 `--key` 参数，
网关 key 只能从 `LLMGW_GATE_KEY`/`GW_KEY`/`LLMGW_SERVE_KEY` 读取，避免泄漏到 shell history。
脚本还会维护 `.llmgw-release-evidence/rollout-ledger.jsonl` 台账；除 `shadow-start` 外，每个阶段默认要求
同一 commit 的所有前置阶段已有 `success` 记录，且当前阶段写入 `success` 前必须能读到 verdict=pass 的
stage/serving-probe/gw-smoke 证据；canary/http 阶段还必须读到 verdict=pass 的 release-gate 证据。
台账不会只看 verdict：stage report 的 `commit`、serving probe 的 health 样本 commit、release gate 的
`shadowReleaseCommit` 与每个 shadow check 的 `releaseCommit` 都必须匹配当前发布 commit。这样可以防止
跳过证据期、换 commit 后沿用旧证据，或台账 success 但证据文件缺失。确需人工越级时必须显式
加 `--allow-out-of-order --allow-out-of-order-reason "<原因>"`（或设置 `LLMGW_ALLOW_OUT_OF_ORDER_REASON`）；
原因会写入 stage report 与 rollout ledger，缺失时脚本拒绝推进。越级不会跳过当前阶段的证据文件校验。
脚本执行非回滚阶段前还会校验发布 commit 包含最新 `origin/main`（可用 `--main-ref` /
`LLMGW_RELEASE_MAIN_REF` 指定其它主干 ref），不满足时拒绝推进；stage report 和 rollout ledger 会记录
`releaseMainRef` 与 `releaseMainSha`，`audit` 子命令也会要求这些字段存在，防止未合入最新 main 的 commit 被当成生产候选。
阶段推进还默认要求前一阶段 `success` 记录至少已观察 24 小时（`LLMGW_STAGE_MIN_OBSERVATION_HOURS` /
`--min-observation-hours` 可调），因此 canary 批次不能在同一小时内连续推进；只有 shadow 样本门、serving probe、
D 层 smoke 与阶段观察窗口都满足后，台账才允许进入下一阶段。
`rollback-rehearsal` 只用 `LLMGW_ROLLBACK_DRY_RUN=1` 演练回滚脚本，不重启 API；任何 canary/http 阶段都必须
先在同一 commit 的台账里看到 `rollback-rehearsal success`，防止没有回滚路径演练就进入灰度或全量。
需要回答“当前 commit 是否已满足某个发布阶段”时，不人工翻 JSONL；统一跑：
`python3 scripts/llmgw-rollout-ledger.py audit --ledger .llmgw-release-evidence/rollout-ledger.jsonl --commit <sha> --target-stage http-full --require-target-success`。
该审计会检查同一 commit 的 shadow、rollback rehearsal、各 canary 与 http-full 成功记录，重新读取每个阶段的
stage/serving-probe/gw-smoke/release-gate 证据文件 verdict 与 commit 归属，并校验相邻正式阶段观察窗口。readiness 总 gate 可加
`--run-rollout-ledger --require-rollout-complete` 把这本台账纳入最终 PASS/FAIL；没有 http-full success 时必须返回 fail，
禁止把“代码门禁齐了”误报成“生产全量迁移完成”。
灰度阶段会自动设置 `LLMGW_MODE=shadow`、对应 `LLMGW_CANARY_STAGE` 与 allowlist；`http-full`
会设置 `LLMGW_MODE=http` 并依赖 `exec_dep.sh` 的全量证据门。`rollback-inproc` 只调用
`scripts/llmgw-rollback-inproc.sh`，不回滚数据库。

灰度 `LLMGW_HTTP_APP_CALLER_ALLOWLIST` 非空且不是全量 `LLMGW_MODE=http` 时，必须显式设置
`LLMGW_CANARY_STAGE=intent-text|chat|streaming|vision|image|video-asr`；`exec_dep.sh` 会校验 allowlist
只能包含该阶段允许的 appCaller，防止越级把 image/video/ASR 混进低风险文本灰度。canary 阶段如果未显式设置
`LLMGW_GATE_REQUIRED_KINDS`，会按阶段自动要求 `send`、`stream` 或 `raw` 样本；vision/image/video-asr 阶段还会默认
要求对应 raw appCaller 的 `appCaller:raw` 样本逐个达标。
如果 `LLMGW_MODE=shadow` 且 `LLMGW_SHADOW_FULL_SAMPLE_PERCENT` 非 0，`exec_dep.sh` 会在 compose 起新镜像后
强制 run serving probe 与 D 层 smoke，但不会要求已有 shadow 样本数，以便安全启动证据期。
http/canary 发布默认还会在部署后强制运行 `scripts/gw-smoke.py`，真打 healthz/pools/send/stream/client-stream/canary；
仅在人工强制场景显式设置 `LLMGW_GATE_RUN_SMOKE=0` 才跳过，并会打印警告。
同时默认在部署后强制运行 `scripts/llmgw-serving-probe.py`，连续检查 serving healthz commit 稳定性与无 key 访问 401；
仅在人工强制场景显式设置 `LLMGW_GATE_RUN_SERVING_PROBE=0` 才跳过，并会打印警告。
全量 `http` 或 allowlist canary 时 `exec_dep.sh` 默认用
`LLMGW_GATE_HEALTH_SAMPLES=3` 和 `LLMGW_GATE_HEALTH_INTERVAL_SECONDS=5` 连续采样 healthz，任一
采样失败、commit 与发布 sha 不一致或多次采样 commit 漂移都会拒绝发布。需要防止 resolve-only 证据误放行时，
用 `LLMGW_GATE_REQUIRED_KINDS=send:30,stream:30` 和
`LLMGW_GATE_REQUIRED_APP_KINDS=report-agent.generate::chat:send:30` 强制指定真实 http 样本。
全量 `http` 或 allowlist canary 时 `exec_dep.sh` 还会默认设置 `LLMGW_GATE_MIN_COVERAGE_HOURS=24`，
要求每个 shadow 检查的最早样本到最晚样本至少覆盖 24 小时；这和 `LLMGW_GATE_SHADOW_SINCE_HOURS=24`
一起使用，防止短时间突刺凑满样本后立即放行。只有明确的人工强制场景才允许设为 `0` 关闭。
全量 `LLMGW_MODE=http` 时如果未显式设置 `LLMGW_GATE_REQUIRED_KINDS`，`exec_dep.sh` 会默认要求
`send:${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}`、
`stream:${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}` 和
`raw:${LLMGW_GATE_FULL_HTTP_KIND_MIN:-${LLMGW_GATE_MIN_PER_APP:-30}}` 三类 shadow 样本达标，避免只靠
resolve-only 或单一路径证据放行全量切换；raw 样本由 `ShadowFullSamplePercent>0` 的生图/ASR/视频原始代理采样产生，
用于证明 multipart/raw 已真实跨进程通过 serving；canary allowlist 阶段不自动追加全局 kind，仍按 allowlist/app-kind
逐批收紧。
全量 `LLMGW_MODE=http` 时如果未显式设置 `LLMGW_GATE_REQUIRED_APP_KINDS`，`exec_dep.sh` 还会默认要求
`visual-agent.image.text2img::generation:raw`、`visual-agent.image.img2img::generation:raw`、
`visual-agent.image.vision::generation:raw`、`video-agent.videogen::video-gen:raw`、
`document-store.subtitle::asr:raw`、`transcript-agent.transcribe::asr:raw` 分别达到
`LLMGW_GATE_FULL_HTTP_APP_KIND_MIN`（默认继承 kind/app 样本门槛），避免某个图片/视频/ASR 入口只靠
其它入口的 raw 样本或自身 resolve 样本被误放行。
全量 `LLMGW_MODE=http` 时如果未显式设置 `LLMGW_GATE_APP_CALLERS`，`exec_dep.sh` 还会默认要求
`report-agent.generate::chat`、`prd-agent-desktop.chat.sendmessage::chat`、`open-platform-agent.proxy::chat`、
`prd-agent-web.model-lab.run::chat`、`prd-agent.arena.battle::chat`、`visual-agent.image.text2img::generation`、
`visual-agent.image.img2img::generation`、`visual-agent.image.vision::generation`、`video-agent.videogen::video-gen`、
`document-store.subtitle::asr`、`transcript-agent.transcribe::asr` 每个入口样本达标；可用
`LLMGW_GATE_FULL_HTTP_APP_CALLERS` 显式替换这组核心入口。
正式发布脚本默认 `LLMGW_GATE_SHADOW_SINCE_HOURS=24`，只接受最近 24 小时内的 shadow 样本；
如需更长证据期，应显式调大该值，禁止用很久以前的历史样本放行当前 commit 的 http/canary 发布。
需要留存第三方可复核证据时，设置 `LLMGW_GATE_JSON_OUT` 与 `LLMGW_GATE_REPORT_MD`，报告只写
base、health commit、每组 shadow 样本数、critical/httpFail 与最终 verdict，不写 `X-Gateway-Key`。

紧急回滚只改 MAP API 的网关路由模式，不回滚数据库、不删 GW 证据、不回退镜像：

```bash
./scripts/llmgw-rollback-inproc.sh
```

脚本会设置 `LLMGW_MODE=inproc`、清空 `LLMGW_HTTP_APP_CALLER_ALLOWLIST`、关闭
`LLMGW_SHADOW_FULL_SAMPLE_PERCENT`，然后仅 `up -d --no-deps --force-recreate api`。
S5 allowlist 或 S6 全量 http 前必须先在目标机器 dry-run/演练这条回滚路径，确认 API 能回到 inproc。

---

## 3. Point 1 — MAP 直连收口清单（6 处，全改走 ILlmGateway）

| 位置 | 说明 |
|---|---|
| `Program.cs` ILLMClient DI 工厂 | 已改走 `ILlmGateway.CreateClient(...)`，不再 `new ClaudeClient/OpenAIClient` |
| `ModelDomainService.GetClientAsync` | 已改走 `ILlmGateway.CreateClient(...)`，保留模型/平台选择语义 |
| `ModelLabController.RunExperiment` | 已改走 pinned gateway，保留“选 A 必须测 A” |
| `ArenaRunWorker.ProcessSlot` | 已改走 pinned gateway，竞技场 slot 不再直连上游客户端 |

**已正确走网关（无需动）**：`OpenAIImageClient`（生图）、`OpenRouterVideoClient`（视频）。

## 4. Point 2 — 旧代码删除清单（前置：http 稳定 + 覆盖率达标）

| 位置 | 删除前置 |
|---|---|
| `LlmGateway.cs`（进程内本体） | httpAllowlist 100% 覆盖后删 |
| `ShadowLlmGateway.cs` | 灰度收敛后删 |
| `ModelResolver.FindLegacyModelAsync:630-641` + 兜底 103-141/321-352 | 所有 ModelType 建默认池 + 迁移率≥60% 后删 |

---

## 5. Point 4 — 遗漏 / 未覆盖清单

- GW 独立数据域主体已落地：控制台账号、登录审计、操作审计、GW serving 请求日志、shadow 对账证据写 `llm_gateway`；MAP 原有日志不迁移、不删除。
- GW 操作审计已覆盖控制台改密、平台启停、模型启停、默认池切换、首次 bootstrap、破玻璃 reset、admin 重新激活、历史账号禁用，写入 `llmgw_operation_audits`。
- 六处直连已收口（§3），当前由 `GatewayDirectClientRatchetTests` 空 baseline 守住；后续发现新增直连即 CI red。
- L1 GatewayTransport 日志标记已落地；后续风险是新增调用点遗漏上下文打标，需继续靠日志页和回归测试发现。
- multipart raw HTTP 化已接通：MAP 侧 inline multipart 上传为 `MultipartFileRefs`，serving 侧 rehydrate 并校验 size/hash；生产 gate 仍要求 ASR/图生图等类别有真实 http 样本。
- serving 容器 HA 未验证——翻 http 前须探活 + 不可达可观测降级。
- shadow 一致性证据不足——仅首条真机 allMatch（样本=1），建议影子 7-14 天。
- Claude 流式 tool_use 已补齐聚合：`content_block_start/tool_use` 与 `input_json_delta` 归一为 OpenAI `tool_calls` delta，继续由 `LlmGateway` 累加进日志与 OpenAI SSE 兼容输出。
- legacy 标记查询未清除（删前置见 §4）。
- CDS 出口可见性缺口（point 0，S1 修）+ 生产 CDS 落后 5 天（S0 self-update）。
- 60-80 MECE 用例骨架已备未编写——S6 gate 前必须补齐。
- 跨项目隔离：共享 Mongo 混入其他分支 llmrequestlogs；Jwt__Secret 双身份轮换前须重加密存量密文。

## 6. 最高风险（翻 http 前必须闭合）

1. **路由分裂回归**：S3 已收口，但任何新增直连都会让部分请求绕过 GW。必须保持 `GatewayDirectClientRatchetTests` 空 baseline 绿灯。
2. **断头翻转无 gate**：S6 必须由 S7 MECE 全绿（尤其 D 层 gw-smoke + shadow 多样本）gate，并演练 `scripts/llmgw-rollback-inproc.sh` 秒回 inproc。
3. **L1 观测回退**：transport 标记已落地，但新增调用点若不透传 context，会让故障定位退化；发布前必须抽查日志 transport 分布。
4. **multipart http 真实样本不足**：代码与集成测试已接通跨进程文件引用，但生图/ASR/字幕类必须有真实 http/shadow 样本，不能只靠 resolve-only 或单元测试放行。
5. **serving 单点**：HA 未验证，serving 挂且无降级 → 全站 LLM 不可用。
6. **删 legacy 兜底**：默认池覆盖 <60% 时删兜底 → 池全不可用无降级。
7. **GW 数据域混乱**：账号由 env/共享库覆盖、日志与 MAP 混在一起，会让控制台无法解释“谁负责哪条记录”。先落 `llm_gateway` 数据域，再推进大规模切换。
8. **密钥双身份轮换**：Jwt__Secret 兼 JWT 签名 + ApiKeyEncrypted 加密，轮换前须先重加密存量密文（历史 CDS_JWT_SECRET 穿透事故）。

---

## 关联

- `doc/plan.llm-gateway.rollout.md`（波1/2/2.5 进度 + 测试纲领）
- `doc/debt.llm-gateway-isolation.md`（回滚/安全/跨项目隔离/L1-L9）
- `.claude/rules/llm-gateway.md`（所有 LLM 调用必须走 ILlmGateway）
- `.claude/rules/cross-project-isolation.md`（Jwt__Secret 双身份 + 共享 Mongo）
