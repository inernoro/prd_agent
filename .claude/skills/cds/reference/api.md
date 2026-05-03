# CDS API 参考（CLI 未覆盖场景用）

> **首选**：`cdscli <cmd>`。以下表格是"CLI 没封装时直接 curl"的 fallback 手册。
> 每个端点的认证一栏以"cdsg / cdsp / bootstrap"标注所需密钥类型。

## 路径

- [核心分组速查](#核心分组速查)
- [AI 配对](#ai-配对)
- [项目](#项目)
- [分支](#分支)
- [日志与诊断](#日志与诊断)
- [基础设施](#基础设施)
- [环境变量（scope 感知）](#环境变量scope-感知)
- [Agent Key](#agent-key)
- [自更新](#自更新)
- [维护](#维护)

## 核心分组速查

| 分组 | 路径前缀 | 何时用 |
|------|----------|--------|
| AI 配对 | `/api/ai/*` | 动态认证（方式 B）|
| 项目 | `/api/projects*` | 项目 CRUD + stats |
| 分支 | `/api/branches*` | 部署 / 拉取 / 停止 / 删除 |
| 诊断 | `/api/branches/:id/container-*` | 容器日志 / exec / env |
| 基础设施 | `/api/infra*` | MongoDB / Redis 等 |
| 环境变量 | `/api/env*` | scope 感知 _global / projectId |
| Agent Key | `/api/projects/:id/agent-keys`, `/api/global-agent-keys` | 签发 / 吊销 |
| 自更新 | `/api/self-*` | 切 CDS 自身分支 |

## AI 配对

| 方法 | 路径 | 用途 | 认证 |
|------|------|------|------|
| POST | `/api/ai/request-access` | 发起配对 | 无 |
| GET | `/api/ai/request-status/:id` | 查状态 | 无 |
| POST | `/api/ai/approve/:id` | 批准 | bootstrap |
| POST | `/api/ai/reject/:id` | 拒绝 | bootstrap |

## 项目

| 方法 | 路径 | 用途 | CLI 等价 |
|------|------|------|----------|
| GET | `/api/projects` | 列表（含 branchCount / runningServiceCount / lastDeployedAt）| `cdscli project list` |
| GET | `/api/projects/:id` | 详情 | `cdscli project show <id>` |
| POST | `/api/projects` | 创建（仅 bootstrap / global key；项目 key 403） | `cdscli project create --name --git-url --slug --description` |
| PUT | `/api/projects/:id` | 更新 | — |
| DELETE | `/api/projects/:id` | 删除（含级联清理：branches/buildProfiles/infraServices/routingRules）| `cdscli project delete <id>` |
| POST | `/api/projects/:id/clone` | 异步 git clone（SSE：progress / detect / profile / env-meta / done / error）| `cdscli project clone <id>` |
| POST | `/api/projects/:id/pending-import` | 提交 compose YAML 待审批 | `cdscli scan --apply-to-cds <id>` |

> 一键 onboarding（create + clone + 检测 required env keys）: `cdscli onboard <git-url>`。

## 分支

| 方法 | 路径 | CLI 等价 |
|------|------|----------|
| GET | `/api/branches?project=<id>` | `cdscli branch list --project` |
| POST | `/api/branches` | `cdscli branch create --project --branch`（CLI 用 `--project`，body 字段是 `projectId`，CLI 抹平此 friction） |
| PATCH | `/api/branches/:id` | — |
| DELETE | `/api/branches/:id` | `cdscli branch delete` |
| POST | `/api/branches/:id/pull` | — |
| POST | `/api/branches/:id/deploy` | `cdscli branch deploy` (SSE) |
| POST | `/api/branches/:id/deploy/:profileId` | 单 profile 重部 |
| POST | `/api/branches/:id/stop` | — |
| POST | `/api/branches/:id/reset` | 清 error 标记 |

## 日志与诊断

| 方法 | 路径 | CLI 等价 |
|------|------|----------|
| GET | `/api/branches/:id/logs` | `cdscli branch history` |
| POST | `/api/branches/:id/container-logs` | `cdscli branch logs --profile` |
| POST | `/api/branches/:id/container-env` | — |
| POST | `/api/branches/:id/container-exec` | `cdscli branch exec --profile` |
| GET | `/api/branches/:id/git-log` | — |

`container-logs` / `container-env` / `container-exec` 的 body 都要 `{ "profileId": "api|admin|..." }`。

## 基础设施

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/infra?project=<id>` | 列表 |
| POST | `/api/infra/:id/start` | 启动 |
| POST | `/api/infra/:id/stop` | 停止 |
| POST | `/api/infra/:id/restart` | 重启 |
| GET | `/api/infra/:id/logs` | 日志 |
| GET | `/api/infra/:id/health` | 健康 |

## 环境变量（scope 感知）

| 方法 | 路径 | 行为 | CLI 等价 |
|------|------|------|----------|
| GET | `/api/env?scope=_global` | 只返回全局桶 | `cdscli env get` |
| GET | `/api/env?scope=<projectId>` | 只返回该项目桶（不合并）| `cdscli env get --scope <projectId>` |
| GET | `/api/env?scope=_all` | 返回整颗 `{_global, <proj1>, <proj2>, ...}` | `cdscli env get --scope _all` |
| PUT | `/api/env?scope=<scope>` | 整体替换该 scope | — |
| PUT | `/api/env/:key?scope=<scope>` | 单键 upsert | `cdscli env set KEY=VALUE [--scope]` 或 `cdscli env set --key K --value V`（value 含 `=` 时优先后者） |
| DELETE | `/api/env/:key?scope=<scope>` | 单键删除 | — |

## Agent Key

| 方法 | 路径 | 认证要求 |
|------|------|----------|
| POST | `/api/projects/:id/agent-keys` | bootstrap 或 cookie |
| GET | `/api/projects/:id/agent-keys` | bootstrap / cookie / 同项目 cdsp |
| DELETE | `/api/projects/:id/agent-keys/:keyId` | 同上 |
| POST | `/api/global-agent-keys` | bootstrap / cookie（项目 key 403）|
| GET | `/api/global-agent-keys` | 任意已认证 |
| DELETE | `/api/global-agent-keys/:keyId` | 非项目 key |

## 自更新

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/self-branches` | 当前分支 + commitHash + 可切换分支 |
| POST | `/api/self-update` | 切分支 + tsc 预检 + 重启（SSE）|
| POST | `/api/self-update-dry-run` | 只跑预检不重启 |

body: `{"branch": "claude/xxx"}`（可选，不传则当前分支 pull）。

## 维护

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/cleanup?project=<id>` | 清该项目（或全部）非默认分支容器 |
| POST | `/api/cleanup-orphans?project=<id>` | 清孤儿容器 |
| POST | `/api/prune-stale-branches?project=<id>` | 清远端已删分支 |
| POST | `/api/factory-reset?project=<id>` | 重置（项目 or 全局）|

## 认证 Header 一览

| Header | 取值 | 适用场景 |
|--------|------|----------|
| `X-AI-Access-Key: <bootstrap>` | `process.env.AI_ACCESS_KEY` | 静态密钥（方式 A）|
| `X-AI-Access-Key: cdsg_<suffix>` | Global Agent Key | 跨项目 bootstrap-equivalent |
| `X-AI-Access-Key: cdsp_<slug>_<suffix>` | Project Agent Key | 绑定单项目 |
| `X-CDS-AI-Token: <token>` | 配对成功后返回 | 动态配对（方式 B）24h 有效 |
| `Cookie: cds_token=xxx` | 浏览器登录后 | 兜底，不推荐 AI 用 |

详细认证决策树见 [auth.md](auth.md)。
