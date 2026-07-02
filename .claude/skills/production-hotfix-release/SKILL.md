---
name: production-hotfix-release
description: Performs a production hotfix release by merging a specific branch or commit into the currently deployed production baseline, building release artifacts, deploying through the existing production script, and verifying live status. Activates only when the user explicitly requests "热发布线上版本", "线上热修", "hotfix production", "把特定分支发到正式环境", or mentions a production SSH host plus a branch/commit to release. Includes strict rules forbidding secrets from being saved in code or exposed in logs.
---

# 线上热修发布

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/hotfix-prod`、"热发布线上版本"、"线上热修"、"把特定分支发到正式环境"、"production hotfix"

把"正式环境当前版本 + 指定分支/提交"做成最小热修发布。适用于用户明确点名要求某个已经合并或未合并的功能进入正式环境，但不希望把当前 `main` 上其它大改动一起带上线。

## 特别授权边界

当且仅当用户明确要求"热发布线上版本"并给出生产目标或 SSH 主机、且给出特定分支/提交/PR 时，本技能特别允许执行以下操作：

| 允许操作 | 条件 |
|---|---|
| SSH 进入生产机做只读排查 | 只查目录、容器状态、镜像 revision、部署脚本位置、非敏感健康接口 |
| 创建热修分支 | 基点必须是生产当前 revision 或明确的线上发布分支 |
| cherry-pick 指定提交 | 只融合用户点名的功能提交和必要依赖 |
| 推送热修分支 | 供 CI 构建发布产物，不自动创建 PR |
| 触发发布 workflow | 使用现有 GitHub Actions 或仓库脚本产出 release artifact |
| 执行生产部署脚本 | 仅使用仓库已有脚本，例如 `exec_dep.sh`，不手写临时部署逻辑 |
| 公网和生产机内网验证 | 只验证状态、版本、非敏感业务接口和页面可访问性 |

这些授权不等于无限制生产权限。任何破坏性操作、数据库写入、删除数据、改密钥、改 `.env`、回滚到未知版本，都必须另行取得用户明确确认。

## 绝对禁止

### 敏感信息

禁止把任何敏感信息保存到代码、文档、changelog、commit message、PR 描述、日志文件或最终回复中：

- API key、access token、refresh token、cookie、session、SSH private key
- 数据库连接串、Redis 密码、MongoDB URI、对象存储密钥
- `.env` 全量内容、容器 `Config.Env` 全量内容、`printenv` 输出
- 第三方 appSecret、webhook secret、OAuth client secret

禁止执行会批量暴露敏感环境变量的命令，例如：

```bash
docker inspect <container> --format '{{json .Config.Env}}'
docker exec <container> printenv
cat .env
grep -R "SECRET\|TOKEN\|PASSWORD\|KEY" .
```

如必须确认某个开关是否启用，只能使用非敏感结果验证：

- 查公开/鉴权状态接口返回的布尔字段
- 查容器镜像 label 的 revision
- 查页面静态包是否包含提交 hash 或特定非敏感文案
- 让用户明确授权后，由用户自行提供脱敏结果

### 发布行为

- 禁止直接在生产机手改源码再发布。
- 禁止把当前 `main` 整体发布到生产，除非用户明确要求发布 `main`。
- 禁止在未确认 CI 构建成功时执行生产部署脚本。
- 禁止用本地临时构建产物覆盖正式环境，除非已有脚本就是这么设计且用户明确同意。
- 禁止自动创建 PR。热修分支可以推送，但 PR 仍需用户明确要求。

## 执行流程

复制此 checklist 跟踪进度：

```text
Task Progress:
- [ ] Step 1: 确认用户点名的功能提交/分支/PR
- [ ] Step 2: 只读确认生产当前 revision 和部署方式
- [ ] Step 3: 创建基于生产 revision 的热修分支
- [ ] Step 4: cherry-pick 指定提交并处理冲突
- [ ] Step 5: 跑本地或远端构建校验
- [ ] Step 6: 推送热修分支并触发 release artifact 构建
- [ ] Step 7: 等待 CI 成功
- [ ] Step 8: 执行生产部署脚本
- [ ] Step 9: 验证线上 revision、容器状态、页面和关键接口
- [ ] Step 10: 汇报发布结果、验证结果、未改动的配置开关
```

### Step 1：确认点名对象

优先解析用户提供的信息：

- PR 号：用 `gh pr view <num> --json number,title,state,mergeCommit,headRefName,baseRefName,url`
- 分支名：用 `git fetch --prune origin` 后查 `git log` 和 `gh pr list --head`
- commit：用 `git show --stat --oneline <sha>`

若用户只说"这一点"，先从上下文推断最近讨论的 PR/commit；推断不唯一时必须问一句确认。

### Step 2：只读确认生产当前版本

允许使用 SSH 做只读排查。目标是找出生产当前实际运行的 revision 和部署入口。

推荐命令形态：

```bash
ssh root@host 'set -eu; docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"; find /root /opt -maxdepth 4 -type d -name .git 2>/dev/null | head -40'
ssh root@host 'docker inspect prdagent-api --format "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}"'
ssh root@host 'cd /root/inernoro/prd_agent && git status --short --branch && git log --oneline -5'
```

注意：生产机 Git 目录可能滞后，实际运行版本以容器镜像 label、前端静态包或部署系统记录为准。

### Step 3：创建热修分支

原则：热修分支基于生产当前 revision，不基于最新 `main`，除非用户明确要发布 `main`。

```bash
git fetch --prune origin
git checkout -b codex/hotfix-<short-name>-prod <production-revision>
```

如果生产 revision 不在本地历史中，先确认远端是否缺失；不要凭猜测找相近 commit。

### Step 4：cherry-pick 指定提交

```bash
git cherry-pick <commit>
git status --short
git show --stat --oneline HEAD
git diff --check HEAD~1..HEAD
```

处理冲突规则：

- 只改用户点名功能相关文件。
- 不顺手合并无关新功能。
- 如果 cherry-pick 牵出大范围依赖，停下并汇报风险，不把热修扩大成隐形发版。

### Step 5：构建校验

按改动范围执行：

| 范围 | 校验 |
|---|---|
| `prd-api/` | `dotnet build PrdAgent.sln -c Release --no-restore`，本机卡住或缺 SDK 时用远端 CI 构建结果兜底 |
| `prd-admin/` | `pnpm tsc --noEmit`，本次改动文件 `pnpm lint --quiet <files>` |
| 发布产物 | GitHub Actions release workflow 必须成功 |

本地校验卡住时可以终止本地进程，但最终必须用 CI 通过作为发布门禁。

### Step 6：推送并触发发布产物

```bash
git push -u origin codex/hotfix-<short-name>-prod
gh workflow run server-deploy.yml --ref codex/hotfix-<short-name>-prod -f docker_platforms=linux/amd64
gh workflow run web-latest-pages.yml --ref codex/hotfix-<short-name>-prod
gh run watch <run-id> --exit-status
```

具体 workflow 名以仓库实际存在的发布流程为准。禁止跳过 CI 直接上生产。

### Step 7：执行生产部署脚本

只使用仓库已有发布脚本。示例：

```bash
ssh root@host 'cd /root/inernoro/prd_agent && set -eu; ./exec_dep.sh'
```

如果脚本会下载前端包、拉取后端镜像、重建 compose，必须检查输出中是否出现：

- 前端包下载成功
- sha256 校验成功或明确按用户要求跳过
- 后端镜像拉取成功
- compose recreate/start 成功

### Step 8：发布后验证

至少验证以下四类，不输出敏感信息：

```bash
ssh root@host 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | grep prdagent'
ssh root@host 'docker inspect prdagent-api --format "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}"'
curl -fsSI https://production-host/login
curl -fsS https://production-host/api/v1/auth/miduo-planet/options
```

验证输出汇总成非敏感摘要：

```text
revision=<hotfix-sha>
containers=api/gateway/mongodb/redis up
login=200
key-api=success true
feature-flag=<true|false|not-applicable>
```

如果功能能力已上线但生产配置开关未开启，必须明确说明"能力已上线，开关未改变"。不要擅自改生产配置。

## 输出模板

```markdown
已完成线上热修发布。

融合方式：
- 生产基线：`<production-revision>`
- 热修分支：`<branch>`
- cherry-pick：`<source-commit>` → `<hotfix-commit>`
- 发布方式：`<workflow>` + `<production-script>`

验证结果：
- 后端镜像 revision：`<hotfix-commit>`
- 容器状态：`api/gateway/... up`
- 登录页：`HTTP 200`
- 关键接口：`success=true`
- 配置开关：`<状态>`（如能力已上线但开关未开启）

敏感信息处理：
- 未读取或输出 `.env` 全量内容
- 未输出容器环境变量全量内容
- 未把 token、secret、连接串写入代码或回复
```

## 示例

用户：

```text
把 SSO 关闭密码登录这个点 cherry-pick 到已经发布到线上环境的分支，然后热发布。ssh root@map.ebcone.net 看正式环境。
```

执行摘要：

```text
1. 查 PR #969 已合并，功能提交为 b805ee581。
2. 只读查生产容器 label，当前线上 revision 为 47a8d7af。
3. 从 47a8d7af 创建 codex/hotfix-sso-password-login-prod。
4. cherry-pick b805ee581，得到 b74cea9d4。
5. 推送热修分支，触发 server-deploy.yml 和 web-latest-pages.yml。
6. 两个 workflow 成功后，在生产机执行 ./exec_dep.sh。
7. 验证生产容器 revision 为 b74cea9d4，登录页 200，SSO options 接口 success=true。
8. 发现 passwordLoginDisabled=false，汇报能力已上线但未擅自开启生产开关。
```

## 关联技能

| 场景 | 技能 |
|---|---|
| 常规版本号发布 | `release-version` |
| 灰度/CDS 分支部署验证 | `cds-deploy-pipeline` |
| 冒烟接口生成 | `smoke-test` |
| 交付清单 | `task-handoff-checklist` |
