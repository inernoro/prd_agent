---
name: cds
version: 0.8.0
description: CDS (Cloud Dev Space) core skill — hosts the canonical cdscli Python CLI, handles authentication (static AI_ACCESS_KEY / dynamic pairing / project key), manages env vars and project keys, owns CDS service self-update, defines the preview-URL slug formula, and acts as dispatcher when the user's intent is ambiguous between cold-path scanning and hot-path debugging. Activates when the user mentions CDS generically without specifying scan-or-deploy, configures CDS credentials, manages env / keys, updates the CDS service code itself, or asks about preview URL conventions. Does NOT directly perform project scanning (delegates to cds-project-scan, the cold path) or deployment debugging (delegates to cds-deploy-pipeline, the hot path). Trigger phrases include "cds 认证", "AI_ACCESS_KEY", "项目 key", "cds 自更新", "cds self-update", "预览地址公式", "配 cds 环境变量", "/cds", "/cds-auth", and the bare word "cds" when the user has not yet picked a direction.
---

# CDS — 核心技能：鉴权 / cdscli / env / self-update / 分诊器

> **版本**：v0.8.0 | **状态**：已落地 | **触发**：`/cds`、`/cds-auth`、"cds 认证"、"AI_ACCESS_KEY"、"项目 key"、"cds 自更新"、"预览地址公式"、"配 cds 环境变量"

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
| `AI_ACCESS_KEY` 静态密钥配置 + 校验 | 项目扫描 / compose 生成（`cds-project-scan`） |
| 动态配对（Dashboard 批准） | 推送代码 / 部署到分支（`cds-deploy-pipeline`） |
| 项目级 `cdsp_*` Key 提取 + 使用 | 看容器日志（`cds-deploy-pipeline`） |
| env 变量 get/set（`_global` / `<projectId>` scope） | 冒烟测试（`cds-deploy-pipeline`） |
| `cdscli self update` 切分支 + 重启 CDS | |
| 预览 URL slug 公式（v3 SSOT） | |
| cdscli 命令总览 / 安装位置 / init 向导 | |

## cdscli — 唯一 CLI 入口（其他两个技能也走它）

```bash
CLI="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"

# 鉴权
$CLI auth check                          # 校验 CDS_HOST + AI_ACCESS_KEY
$CLI init                                # 交互式向导（首次接入）

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

## 认证：三种方式（按优先级）

### 首选：项目专属 Key（零心智）

用户粘贴包含 `CDS_PROJECT_KEY=cdsp_...` 的代码块，AI 直接提取作为本次会话凭证：

```bash
export CDS_HOST=https://xxx.miduo.org
export CDS_PROJECT_ID=prd-agent-2
export CDS_PROJECT_KEY=cdsp_prd-agent-2_a1B2c3D4e5F6...
curl -sf -H "X-AI-Access-Key: $CDS_PROJECT_KEY" "$CDS_HOST/api/projects/$CDS_PROJECT_ID"
```

返回 `403 project_mismatch`：告诉用户去对应项目页点「授权 Agent」按钮重新生成。

### A: 静态密钥（推荐，零交互）

`process.env.AI_ACCESS_KEY` 配好，AI 请求带 `X-AI-Access-Key` header。

### B: 动态配对

AI `POST /api/ai/request-access` → 用户在 Dashboard 点批准 → 拿 24h token → 后续请求带 `X-CDS-AI-Token` header。

### C: Cookie（兜底）

用户从浏览器 DevTools 复制 `cds_token`，AI 用 `Cookie: cds_token=...` 兜底。

完整认证决策树（含错误码处理） → [reference/auth.md](reference/auth.md)

### 硬性禁令

1. **禁止 `X-Cds-Internal: 1`**：能认证但 Activity 无 AI 标记，违反可观测性。
2. **Bash 调用间变量隔离**：动态配对的 token 必须在**同一个 Bash 调用**内用 `&&` 链接完成，跨调用变量会丢。
3. **AI 操作必须可见**：所有 AI 请求会出现在 CDS Dashboard 右下角监控浮窗，标紫色 "AI" 标签。

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

## CDS 服务自更新（改了 cds/ 目录的代码）

触发条件（AI 自动判断）：`git diff --name-only HEAD~1 HEAD | grep ^cds/` 非空。

```bash
$CLI self update --branch <branch>       # 切 + pull + 重启 CDS 进程
# 重启约 10s，CLI 内部已轮询 /api/config 等恢复
```

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
