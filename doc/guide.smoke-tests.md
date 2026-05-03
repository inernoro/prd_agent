# 冒烟测试 · 指南

> Phase 2 交付物 —— 部署后快速验证关键链路是否跑通。

---

## 作用

CDS 灰度环境部署完成并不等于业务可用：镜像能起来，但 Controller 可能被我改坏了、LLM Gateway 可能 401、数据库可能被环境变量错拼导致连接失败。Phase 2 的冒烟脚本用 **真实 curl 打真实预览域名**，在几十秒内发现这些"容器绿、接口红"的情况，是介于单元测试和真人 UAT 之间的一层。

不是为了取代 UAT，而是为了让每次 `/cds-deploy` 之后人类不用自己去点 10 个页面。

---

## 文件清单

| 文件 | 作用 |
|------|------|
| `scripts/smoke-lib.sh` | 共享辅助：curl/jq 封装、断言、重试、日志格式 |
| `scripts/smoke-health.sh` | 连通 + 鉴权（含 2 条负向测试：无效 key / 缺 impersonate） |
| `scripts/smoke-prd-agent.sh` | PRD Agent 链路：Group → Session → Run → 轮询 Completed |
| `scripts/smoke-defect-agent.sh` | 缺陷 CRUD + 讨论消息追加 |
| `scripts/smoke-report-agent.sh` | 团队/模板/周报 CRUD |
| `scripts/smoke-all.sh` | 串行执行所有冒烟，汇总 pass/fail/skip |

---

## 快速上手

### 1. 本地跑

```bash
# 环境变量三件套
export SMOKE_TEST_HOST=https://my-branch.miduo.org
export AI_ACCESS_KEY='xxx'       # prd-api 的 X-AI-Access-Key
export SMOKE_USER=admin          # 假冒的用户 login

# 一把梭
bash scripts/smoke-all.sh
```

输出长这样：

```
##########################################
# PRD Agent 大全套冒烟测试 (smoke-all.sh)
##########################################
==========================================
冒烟测试: Health & Auth
目标:     https://my-branch.miduo.org
用户:     admin (impersonate)
==========================================

>>> [1/4] 验证 prd-api 可达 (带 3 次指数退避重试)
✅ HTTP 可达
...
##########################################
# 冒烟测试汇总 (总耗时 37 秒)
##########################################
✅ 通过: 4 项
    · Health & Auth
    · PRD Agent
    · Defect Agent
    · Report Agent
❌ 失败: 0 项
⏭  跳过: 0 项
```

### 2. 只跑一两个子冒烟

```bash
# 只跑 health + prd-agent，跳过 defect + report
SMOKE_SKIP=defect,report bash scripts/smoke-all.sh

# 或单独跑
bash scripts/smoke-health.sh
bash scripts/smoke-prd-agent.sh
```

### 3. CI fail-fast 模式

```bash
SMOKE_FAIL_FAST=1 bash scripts/smoke-all.sh
```

首个失败的子冒烟就直接退出，不继续跑后续 —— CI 里节省分钟级的算力。

### 4. 开启详细日志

```bash
SMOKE_VERBOSE=1 bash scripts/smoke-all.sh
```

会打印每步的 JSON 响应关键字段，排查失败时用。

---

## 环境变量参考

| 变量 | 默认 | 说明 |
|------|------|------|
| `SMOKE_TEST_HOST` | `http://localhost:5000` | 目标根 URL，支持 CDS 预览子域名 |
| `AI_ACCESS_KEY` | **必填** | prd-api 校验的 `X-AI-Access-Key` 值 |
| `SMOKE_USER` | `admin` | 被假冒的用户 login（必须在 users 集合存在） |
| `SMOKE_TIMEOUT` | `20` | 单次 curl 超时秒数 |
| `SMOKE_VERBOSE` | _(空)_ | 非空时打印完整 JSON 响应摘要 |
| `SMOKE_SKIP` | _(空)_ | 逗号/空格分隔要跳过的 key（`health`/`prd-agent`/`defect`/`report`） |
| `SMOKE_FAIL_FAST` | _(空)_ | 非空时首次失败即退出 |

---

## 集成到 CI

### 手动触发（已配置）

`.github/workflows/ci.yml` 里新增了 `smoke-preview` job，只在 `workflow_dispatch`（手动触发）时跑。入口参数：
- `host`：预览域名 URL（例：`https://my-branch.miduo.org`）

在 GitHub Actions → CI → Run workflow 里填好 `host` 即可。`AI_ACCESS_KEY` 走 repo secret，名字同名。

**为什么只做手动触发而不是每 PR 自动跑？**
- 自动冒烟需要目标 URL，而 CDS 灰度部署是 `/cds-deploy` 触发的独立链路
- 强行在 CI 里拉起一个完整 CDS 会把 PR 时长拖到 10 分钟以上
- Phase 3 计划把这一步塞进 `/cds-deploy` 完成后的 hook，而不是在 GitHub Actions 里

### 和 `/cds-deploy` 联动（建议）

部署流程示意：

```
PR commit
   ↓
/cds-deploy (CDS skill)
   ↓ 绿灯
bash scripts/smoke-all.sh (host=branch 预览域名)
   ↓ 绿灯
真人 /uat 验收
```

---

## 设计约束

### 数据清洁

每个子冒烟在结束时 **best-effort** 删除自己创建的测试数据（Group/Session/Defect/Team/Report）。即便删除失败，残留数据的 `title` 字段也会带 `smoke-<时间戳>` 前缀，方便 DBA 批量清理。

不要在生产环境跑包含写操作的冒烟 —— 虽然数据可标识，但 LLM 真实调用会消耗真实配额，建议只在 CDS 预览环境/灰度跑。

### 错误处理

- 每个子脚本都用 `set -euo pipefail`，任何 curl 失败/断言失败都会立刻退出
- `smoke-all.sh` 默认 **不 fail-fast**，让一次跑完能看到所有问题
- 失败的步骤会打到 stderr（`❌ xxx`），成功打到 stdout（`✅ xxx`），便于 CI 日志过滤

### 扩展新 Agent

在 `scripts/` 下加 `smoke-<name>-agent.sh`，以现有脚本为模板：

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=smoke-lib.sh
source "$SCRIPT_DIR/smoke-lib.sh"

SMOKE_STEP_TOTAL=N
smoke_init "Your Agent Name"

smoke_step "做某事"
resp=$(smoke_post /api/your-agent/xxx '{"foo":"bar"}')
id=$(smoke_get_data "$resp" .id)
smoke_assert_nonempty "$id" "id"
smoke_ok "ok"

smoke_done
```

然后在 `smoke-all.sh` 的 `SMOKES` 数组追加一行：

```bash
"your-agent|$SCRIPT_DIR/smoke-your-agent.sh|Your Agent Name"
```

---

## 限制与不做

- ❌ **不测 LLM 响应质量** —— 只测 Controller 接 LLM Gateway 的链路是否畅通
- ❌ **不测 UI 渲染** —— Phase 3 (Playwright + Bridge) 负责
- ❌ **不替代单元测试** —— `dotnet test` / `pnpm test` 仍然是代码级正确性的门禁
- ❌ **不在 CI 自动跑** —— 需要真实部署环境，走手动或 `/cds-deploy` hook

---

## 相关文档

- `.claude/skills/smoke-test/SKILL.md` —— `/smoke` 技能定义
- `.claude/rules/cds-first-verification.md` —— CDS 优先验证原则
- `.claude/rules/e2e-verification.md` —— 端到端验收原则
- `doc/plan.cds-status.md` —— CDS 当前状态看板(Phase 2 已并入主进度)
