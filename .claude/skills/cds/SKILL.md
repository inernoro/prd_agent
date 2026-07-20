---
name: cds
version: 0.10.0
description: CDS (Cloud Dev Space) core skill — provides cross-Agent, project-scoped onboarding without copying keys or modifying shell profiles, hosts the canonical cdscli Python CLI, manages CDS authentication and project access, owns CDS service self-update, exposes managed deployment runs and versions, defines the preview-URL slug formula, and dispatches scanning or deployment work to the matching CDS skill. Activates for CDS onboarding, connect, authentication, deployment status, versions, rollback, self-update, preview URLs, or the bare word CDS when intent is unclear.
---

# CDS — 核心技能：安全接入 / cdscli / 托管交付 / self-update / 分诊器

> **版本**：v0.10.0 | **状态**：已落地 | **触发**：`/cds`、`/cds-auth`、"接入 CDS"、"CDS 授权"、"部署记录"、"版本回滚"、"cds 自更新"、"预览地址公式"

> **冷热分离**：
> - 接入新项目、生成 compose、上传 YAML → **`cds-project-scan`**（冷路径）
> - 部署 / 调试 / 看日志 / 冒烟 → **`cds-deploy-pipeline`**（热路径）
> - 认证、env、Key、CDS 服务自更新、SSOT 公式 → **本技能**

## 分诊器（用户只说"cds"或意图模糊时）

用户说"帮我看看 cds" / "搞下 cds" / 单独 `/cds` 时，**不要立即跑命令**，先反问一句区分意图：

```
CDS 这边您想做什么？
  (1) 新项目接入 / 生成 compose / 上传配置  → 我去走「冷路径」（cds-project-scan）
  (2) 部署 / 看日志 / deploy 失败排查      → 我去走「热路径」（cds-deploy-pipeline）
  (3) 配认证 / 改 env / 项目 Key 管理       → 留在这里处理
  (4) 更新 CDS 服务本体（改了 cds/ 代码）   → 留在这里处理
```

明确触发词（含"扫描" / "部署" / "认证"）就直接派发，**不要再问**。

## 本技能处理 / 不处理

| 处理 | 不处理（去对应技能） |
|---|---|
| 页面批准式安全接入（不复制密钥） | 项目扫描 / compose 生成（`cds-project-scan`） |
| 项目级凭据加载与旧环境变量兼容 | 推送代码 / 部署到分支（`cds-deploy-pipeline`） |
| 部署运行记录、失败诊断、版本与回滚 | 看容器日志（`cds-deploy-pipeline`） |
| env 变量 get/set（`_global` / `<projectId>` scope） | 冒烟测试（`cds-deploy-pipeline`） |
| `cdscli self update` 切分支 + 重启 CDS | |
| 预览 URL slug 公式（v3 SSOT） | |
| cdscli 命令总览 / 安装位置 / init 向导 | |

## cdscli — 唯一 CLI 入口（其他两个技能也走它）

```bash
CLI="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"

# 安全接入：默认页面批准，密钥不进入对话或 stdout，不写 shell profile
$CLI connect --host https://cds.example --project <id> --agent Codex
$CLI connect --host https://cds.example --new-project --agent Cursor
$CLI init                                # 交互式安全向导
$CLI init --legacy-env                   # 仅兼容旧用户：写 ~/.cdsrc
$CLI auth check                          # 校验当前项目凭据

# 托管交付真相：运行过程与可复用版本
$CLI deployment-run list --project <id>
$CLI deployment-run show <runId>
$CLI deployment-run diagnose <runId>
$CLI deployment-version list --project <id>
$CLI deployment-version deploy <versionId>

# Env 管理
$CLI env get --scope _global
$CLI env get --scope <projectId>
$CLI env set DB_PASS=s3cret --scope <projectId>

# 构建配置：就绪超时(探活) / 部署模式 —— AI 用 key 直接设，不依赖 dashboard
# （这些以前被误以为是 dashboard 专属、API key 设不了，其实和 branch deploy 同一套鉴权）
$CLI profile list --project <id>                 # 列出 profile + 当前部署模式 + 就绪超时
$CLI profile deploy-mode <profileId> dev         # 切 profile 激活部署模式（--reset 恢复默认）
$CLI profile readiness <profileId> --timeout 1200  # 设就绪探测超时秒数（GET-合并-PUT 保留其它字段）
$CLI profile readiness <profileId> --no-http     # 后台 worker：跳过 HTTP 探测只做 TCP（--http 撤销）
$CLI branch set-mode <branchId> <profileId> dev  # 单分支部署模式覆盖（如把某预览分支 web 改 dev）
# 注：就绪超时是「每服务/每 profile」级（无系统全局默认值），无标签时运行时默认 180s。
#     改完都需要重新部署生效（$CLI branch deploy <id>）。

# Key 管理
$CLI global-key list                     # 全局 bootstrap key
$CLI global-key create --label "for claude onboarding"
$CLI key list --project <id>             # 项目级 cdsp_* key（只读列出）
# 注：cdscli 无 key create。项目 Key 由用户在项目页「授权 Agent」按钮签发，
#     明文只展示一次（见下方「认证」节）。CLI 不签发，避免密钥经 stdout 泄漏。

# 任务调度：一句口令生成/测试/创建任务（自然语言解析为 schedule + actions）
$CLI schedule parse "每天 02:00 调用 POST /api/statistics/sync" --project <id>
$CLI schedule test "手动 执行命令 echo ok" --project <id>
$CLI schedule create "每天 03:30 curl -X POST https://old.example/sync" --project <id> --test
$CLI schedule list --project <id>
$CLI schedule run <scheduledJobId>
# 支持调度口令：每天 02:00 / 每隔 10 分钟 / 手动
# 支持动作口令：curl ... / 调用 POST https://... / 执行命令 ...

# CDS 服务自更新（仅改 cds/ 代码时）
$CLI self branches                       # 看 CDS 自身能切到哪些分支
$CLI self update --branch <branch>       # 切 + pull + 重启 CDS 进程

# 验收报告 / 视觉取证（CDS 自托管 HTML/Markdown，登录态门控，可按项目/文件夹归类）
$CLI report-folder create --name "2026-06 验收"        # 建文件夹（可 --project）
$CLI report create --title "CDS · X · 验收报告" --html-file r.html --folder <fid> [--project <id>]
$CLI report list --folder <fid>                        # 列出（可 --project / --folder）
$CLI report deeplink <reportId>                        # 打印 /reports?folder=&report= 直达深链
$CLI report-folder list [--project <id>]
# 视觉取证全流程（穿 agent 代理的浏览器取证 + 组装 HTML 入库）见 reference/acceptance-reports.md +
# cli/acceptance/（proxyroute.mjs / cds-harness.mjs / build_report_html.py / driver.template.mjs）
```

完整命令族 → `$CLI --help`，分技能用法 → `cds-project-scan` / `cds-deploy-pipeline` 各自的 SKILL.md。

## Agent 使用任务调度口令的标准流程

当用户说「给 CDS 加一个定时任务」「每天拉一次数据」「先测试一下这个任务」「把这段 curl 定时跑」时，Agent 必须优先走 `cdscli schedule`，不要手写 curl 调 `/api/scheduled-jobs`。

### 决策流程

1. **先确定项目作用域**：
   - 用户提供 `CDS_PROJECT_ID` / `--project` / 项目名能唯一对应项目时，传 `--project <id>`。
   - 当前环境已有 `CDS_PROJECT_ID` 时可省略 `--project`。
   - 项目不明确时先 `project list`，仍不明确再问用户；不要创建无项目任务。
2. **先解析口令**：
   ```bash
   $CLI schedule parse "每天 02:00 调用 POST /api/statistics/sync" --project <id>
   ```
   用解析结果确认 `schedule.type`、`timeOfDay/intervalMinutes`、`actions` 是否符合用户话术。
3. **涉及真实外部调用或命令时，先测试**：
   ```bash
   $CLI schedule test "手动 执行命令 echo ok" --project <id>
   ```
   `test` 只调用 `/api/scheduled-jobs/check-target`，不创建任务。失败时把失败日志总结给用户，不要继续 create。
4. **创建时默认带 `--test`**：
   ```bash
   $CLI schedule create "每天 03:30 curl -X POST https://old.example/sync" --project <id> --test
   ```
   只有用户明确说「先创建，之后再测」时才允许不带 `--test`。
5. **创建后交付 task id 和验收命令**：
   - 返回 `job.id`。
   - 告知可用 `$CLI schedule run <jobId>` 手动触发一次。
   - 告知可用 `$CLI schedule list --project <id>` 查看。

### 口令格式

调度部分支持：
- `每天 02:00` / `每日 2点` / `daily 02:00`
- `每隔 10 分钟` / `每 2 小时`
- `手动` / `只手动`

动作部分支持：
- `curl -X POST -H 'Content-Type: application/json' -d '{"a":1}' https://example.com/sync`
- `调用 POST /api/statistics/sync`
- `执行命令 node scripts/sync.js`

多个动作可用「然后 / 接着 / 再执行」连接，例如：

```bash
$CLI schedule create "每天 02:00 curl -X POST https://old.example/pull 然后 执行命令 node clean.js" --project <id> --test
```

### 失败处理

- `未识别调度口令`：让用户补充「每天/每隔/手动」之一。
- `未识别执行动作`：让用户提供 `curl`、HTTP URL 或命令脚本。
- `任务动作检测未通过`：不要创建任务；总结 `checks[].result.log/error`，让用户修正 URL、鉴权、命令或服务状态。
- `project_mismatch`：说明当前项目 key 不属于目标项目，让用户在目标项目页重新授权 Agent。

### 安全边界

- 命令动作由 CDS 服务端放进 Docker sandbox 执行，Agent 不要在本地代跑危险命令来“帮用户测试”。
- 含密钥的 curl 可以交给 `schedule test/create`，但最终回复不要复述完整密钥值。
- 用户只说「定时跑这个」但没有调度时间时，不要猜默认每天；先要求补齐调度。

## 认证：页面批准优先

### 已有项目

在目标 git 仓库目录运行：

```bash
$CLI connect --host https://cds.example --project <projectId> --agent <当前 Agent 名称>
```

CLI 免密发起申请，用户在 CDS 右下角批准一次。项目 Key 只由 CLI 接收并写入当前项目
`.cds/credentials.json`，文件权限为 `0600`，同时加入本地 git exclude。密钥禁止出现在对话、
stdout、命令参数、shell profile 或系统环境变量持久配置中。

### 首次创建项目

```bash
$CLI connect --host https://cds.example --new-project --agent <当前 Agent 名称>
```

批准后得到一次性 create-only 授权。`project create` / `onboard` 创建项目成功时，CDS 自动
吊销该授权并返回新项目专属 Key；CLI 静默保存并切换，不打印明文。

### 旧版兼容

已有 `CDS_HOST`、`CDS_PROJECT_KEY`、`AI_ACCESS_KEY` 的进程仍可直接使用。只有用户明确要求
旧流程时才能运行 `cdscli init --legacy-env` 写 `~/.cdsrc`，不得把它作为默认接入方式。

完整认证决策树（含错误码处理） → [reference/auth.md](reference/auth.md)

### 硬性禁令

1. **禁止 `X-Cds-Internal: 1`**：能认证但 Activity 无 AI 标记，违反可观测性。
2. **禁止索要密钥**：默认接入不得让用户把长期 Key 粘进对话或终端命令。
3. **禁止环境侵入**：不得修改 `.bashrc`、`.zshrc`、全局 PATH 或用户主目录技能目录，除非用户明确选择全局安装。
4. **AI 操作必须可见**：所有 AI 请求会出现在 CDS Dashboard 的活动记录中。

## 预览 URL 公式（v3 SSOT）

实现唯一来源：`cds/src/services/preview-slug.ts:computePreviewSlug`。**不要手拼**。

```
有 prefix:  ${tail}-${prefix}-${projectSlug}.miduo.org
无 prefix:  ${tail}-${projectSlug}.miduo.org   (中段省略)
```

- `tail` = 分支名第一个 `/` 之后（slugify：小写 + 非 `[a-z0-9-]` 转 `-`）
- `prefix` = 第一个 `/` 之前（claude / codex / feat / fix），无 `/` 时无 prefix
- `projectSlug` = CDS 项目 slug（从 `/api/projects` 取，不是仓库目录名）

| 分支 | 项目 slug | 预览域名 |
|---|---|---|
| `master` | `geo` | `master-geo.miduo.org` |
| `feat/login` | `geo` | `login-feat-geo.miduo.org` |
| `claude/fix-x` | `prd-agent` | `fix-x-claude-prd-agent.miduo.org` |

**项目 slug 永远在最右侧**。需要拼接 → 调 `/preview-url` 技能或调用 `computePreviewSlug`。

本机 CDS（127.0.0.1）不走域名：`http://127.0.0.1:<host-port>` 或 simple mode 走 `:5500`。

## env 变量 scope 规则

| scope | 含义 | 注入位置 |
|---|---|---|
| `_global` | 全局变量（所有项目所有分支） | 所有容器 |
| `<projectId>` | 项目级（该项目所有分支） | 该项目容器 |
| `_all` | 仅查询用，不能写 | — |

```bash
$CLI env get --scope <projectId>         # 看项目级
$CLI env set MAP_AI_USER=ai-bot --scope <projectId>
```

`cds-compose.yml` 的 `x-cds-env` 段 = 项目级 scope 的声明源。修改后需要重新 deploy 才生效。

## Agent 操作者身份（渐进兼容）

新版 cdscli 会为每次进程生成随机 `agentSessionId`，并在 Codex 环境可用时附带
`threadId` / `turnId`。服务端为变更请求生成 `requestId` / `operationId`，将这些
字段关联到操作事件、发布记录和 CDS 自更新历史。self update/restart 的 CLI 结果
会直接返回这些关联 ID，复盘时不再依赖临时浏览器响应头。

第一阶段只采集和关联，不参与鉴权：旧版技能没有身份头时仍可使用，并标记为
`identityVersion=0`、`confidence=legacy`；新版声明标记为 `identityVersion=1`、
`confidence=declared`。`declared` 只表示格式有效，不代表身份已由服务端验证。
不得因为缺少身份头拒绝旧客户端，也不得把调用方声明提升成可信身份。

## CDS 服务自更新（改了 cds/ 目录的代码）

触发条件（AI 自动判断）：`git diff --name-only HEAD~1 HEAD | grep ^cds/` 非空。

```bash
$CLI self restart                        # 只重启当前精确 SHA，不拉代码、不切分支
$CLI self update --branch <branch>       # 切 + pull + 重启 CDS 进程
# 重启约 10s，CLI 内部已轮询 /api/config 等恢复
```

用户只说“重启 CDS”时必须使用 `self restart`。只有明确要求把 CDS 更新到某个
分支或提交时才使用 `self update`，禁止再把普通重启隐式升级为代码发布。

共享 CDS 会保留当前运行提交。旧技能在“同 SHA”与“目标包含当前提交”的快进更新
中无需新增参数，仍可直接使用。若目标分支不包含当前提交，服务端会在 checkout
之前拒绝，避免一个 Agent 的分支整体覆盖另一个 Agent 已上线的修复。

只有经过核对的正式换代或回滚，才允许显式解除非快进门禁：

```bash
$CLI self update --branch <branch> \
  --transition-intent release \
  --expected-from-sha <当前 self-status headSha> \
  --reason "说明为什么目标分支可以替代当前控制面版本"
```

`--transition-intent` 只允许 `release` / `rollback`。不得把它作为日常兼容参数；
`expected-from-sha` 是乐观锁，生产版本已变化时请求必须失败并重新审计。

注意：self-update 期间 CDS API 短暂不可用（~10s），CDS 内部 state.json 迁移逻辑会自动跑。

## 维护者通道（仅 inernoro/prd_agent 仓库所有者）

> 改 `cli/cdscli.py` / 改 reference / bump VERSION / push —— 你就是技能源头，直接编辑 `.claude/skills/cds/` 即可。**没有发布流程**。

触发词（严格）：`/cds-sync` / `/cds-sync-skill` / "帮我同步 cds 技能" / `cdscli sync-from-cds`。

完整维护者工作流（drift 扫描 → plan-first → 改三文件 → 自检 → changelog）→ [reference/maintainer.md](reference/maintainer.md)

## 反馈缺口给上游 CDS 团队

发现 cdscli / CDS 服务端 bug 或能力缺口（issue #544 / #550 / #551 / #552 类）→ 走 `/audit`（`auto-fix-issues` 技能）协议，**不要**在 CDS skill 内部塞反馈逻辑。

## 参考索引（按需加载）

| 文件 | 何时读 |
|---|---|
| [reference/api.md](reference/api.md) | 直接调 CDS REST API（CLI 未覆盖场景）— 被 `cds-project-scan` / `cds-deploy-pipeline` 共享引用 |
| [reference/auth.md](reference/auth.md) | 401 / 403 / 双层认证决策树 |
| [reference/scan.md](reference/scan.md) | 扫描规则、compose YAML 契约（`cds-project-scan` 详读） |
| [reference/smoke.md](reference/smoke.md) | 分层冒烟策略（`cds-deploy-pipeline` 详读） |
| [reference/diagnose.md](reference/diagnose.md) | 容器日志 → 根因决策树（`cds-deploy-pipeline` 详读） |
| [reference/drop-in.md](reference/drop-in.md) | 新项目接入完整步骤 + 常见问题 |
| [reference/acceptance-reports.md](reference/acceptance-reports.md) | 视觉取证 → CDS 自托管验收报告 → 项目/文件夹归类 → 直达深链（含穿 agent 代理的浏览器取证解法） |
| [reference/maintainer.md](reference/maintainer.md) | 仅 CDS 仓库所有者读 |

## 跨技能依赖

```
       cds (core / dispatcher)
        │
        │ hosts: cli/cdscli.py + reference/*.md
        ▼
   ┌────┴────┐
   │         │
cds-project-scan   cds-deploy-pipeline
 (冷：接入)         (热：调试)
```

两个子技能都从 `../cds/cli/cdscli.py` 引用 CLI，**不维护各自的拷贝**。

## 部署项目的资产存储（prd-agent 图片/报告，2026-06-22）

prd-agent 的图片/验收报告走后端 `IAssetStorage`，由**项目环境变量** `ASSETS_PROVIDER` 选择后端（在「项目环境变量」里配，不是 CDS 全局变量）：

- 未配任何云凭据（典型 CDS 预览）→ 后端自动 **auto 回退 local**，图片存到容器内 `ASSETS_LOCAL_DIR`（默认 `{ContentRoot}/data/assets`），**无需任何配置即可正常传图**（修复"无云凭据实例传图直接失败"）。
- 生产/需云端持久 → 配 `ASSETS_PROVIDER=cloudflareR2` + `R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET`（R2 后端已内置，S3 兼容），或 `tencentCos` + `TENCENT_COS_*`。
- local 是占位/兜底，容器重建即丢；要持久化预览图片可挂卷到 `ASSETS_LOCAL_DIR` 或直接配 R2。

详见 `.claude/skills/create-visual-test-to-kb/SKILL.md`「报告图片与资产存储」。
