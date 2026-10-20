---
name: cds-release
description: 配置并验收 CDS 正式发布。默认执行项目 Git 中经 CI 验证的 cds-release.sh；CDS 独立脚本仅为明确选择的备选，旧部署类型仅兼容存量。强制项目级 Key、身份、同提交 CI、正文指纹、真实入口与回滚证据。
---

# CDS 正式发布配置技能

## 目标

把“某个分支能在 CDS 预览”推进为“该项目有一个身份明确、可重复、可回滚、可审计的正式发布目标”。本技能配置发布控制面，不把“容器 running”误报为发布完成。

## 默认发布合同（优先于旧模式说明）

新目标默认 `project-script`，文件名为 `cds-release.sh`：由项目提交到 Git，
项目 CI 执行同一文件的 `check`，CDS 只在同一完整提交 CI 成功后执行
该提交脚本的 `check / deploy`，记录脚本正文 SHA-256。资源或业务变化由
项目同步修改脚本与回归，不能热改服务器、跳过检查或换旧模式绕过。
只有明确选择时才使用 `managed-script`（CDS 独立保存、单独审查的备选）；
项目文件缺失不能自动转备选。CDS 不推断项目应该怎样部署。

下列旧模式仅为存量目标兼容，不能用于新目标的自动推荐。

## 适用边界

支持三种发布方式：

1. `existing-script`：项目仓库已经有 `deploy.sh`、`exec_dep.sh` 等发布命令。
2. `generated-compose`：项目没有发布脚本，但有 Compose 文件；CDS 为每个 commit 动态生成脚本。
3. `generated-static`：项目没有发布脚本；CDS 动态构建静态产物，离线验证入口资源，原子切换 `current`，保留 `previous`。

暂不把 Kubernetes、GitOps、镜像仓库推送假装成已实现。本技能遇到这些目标时，应明确写“当前发布引擎未实现该执行器”，再建议先借用项目现有脚本或补充执行器。

## 强制安全合同

- AI 写入发布目标必须使用 `cdsp_` 项目级 Agent Key。禁止使用全局 AI key 创建、修改、删除或归档项目发布目标。
- 操作前必须同时确认 `projectId`、`projectSlug`、仓库身份和检测分支。任何一项对不上都停止。
- 不直接删除疑似错误目标。先调用归档接口并写至少 8 个字符的原因，保留创建人、时间、目标地址和历史运行证据。
- 普通 SSH 目标的远端 `appPath` 必须是当前项目的 Git 根目录，且 `origin` 规范化后必须等于 Project 绑定仓库；只看目录名不算身份验证。
- 正式发布必须锚定完整 commit SHA；禁止使用可漂移的 `latest` 代替不可变版本证据。
- 生产完成证据必须包含最终公网 HTML、HTML 实际引用的 JS/CSS、API 健康和本次涉及的专项服务。
- 日志、教程和回复中不得输出 Key、私钥、口令或带凭据的 Git URL。

## 前置输入

优先从上下文和 CDS 查询得到，不要先让用户手工填写：

```text
CDS_HOST             CDS 地址
AI_ACCESS_KEY        当前项目的 cdsp_ Key
projectId            CDS 项目 ID
branchId             已成功运行且已验收的分支 ID
privateKeyRef        已在该项目使用或由管理员预置的 RemoteHost ID
productionDomain     最终公网域名
remoteRepoPath       生产服务器上的当前项目 Git 仓库路径
```

只有 `productionDomain` 或真实远端目录无法从系统查到时，才向用户请求。不要猜域名、目录或服务器。

## 工作流

### 阶段 1：锁定调用身份

1. 设置明确的 `CDS_HOST`，不要依赖 shell 全局默认值。
2. 用项目级 Key 调用项目列表，断言只看到目标项目。
3. 如果响应显示多个项目，或 Key 没有项目作用域，停止写入并输出 `project_key_required`。

参考命令：

```bash
curl -sS -H "X-AI-Access-Key: $AI_ACCESS_KEY" "$CDS_HOST/api/projects"
```

输出中不得回显 `$AI_ACCESS_KEY`。

### 阶段 2：让 CDS 扫描项目事实

```bash
curl -sS \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$CDS_HOST/api/releases/projects/$PROJECT_ID/discover" \
  --data "{\"branchId\":\"$BRANCH_ID\"}"
```

必须检查：

- `projectIdentity.projectId` 等于目标项目。
- `projectIdentity.repository` 等于预期仓库；项目没有绑定仓库时停止配置普通 SSH 目标，先补仓库身份。
- `branchId` 与用户要发布的分支一致。
- `warnings` 不为空时逐条处理，不能静默忽略。
- 推荐策略必须来自 `candidates`，不在前端或技能里另写一套技术栈猜测。

### 阶段 3：选择最短的真实发布路径

按以下优先级决策：

| 条件 | 策略 | 说明 |
|---|---|---|
| 默认 | `project-script` | 提交 `cds-release.sh` 并通过 CI；缺文件就修项目，不猜类型 |
| 用户明确选择 CDS 独立脚本 | `managed-script` | 单独保存、审查，执行 check / deploy |
| 已存在的旧目标 | 保留原模式或明确迁移 | 不静默改变存量行为 |

如果项目脚本直接清空在线目录、使用漂移 tag 或没有最终入口验证，必须先修项目脚本并通过 CI，不得切旧部署模式绕过。

### 阶段 4：生成发布目标配置

完整请求合同见 [references/configuration-contract.md](references/configuration-contract.md)。请求体必须包含：

- 服务端已存在的 `projectId`。
- 用户可识别的目标名。
- RemoteHost 的 host、port、user、privateKeyRef。
- 当前项目远端 Git 仓库 `appPath`。
- 最终公网 `healthcheckUrl`。
- `environment=production` 与 `isCanonical=true`，除非明确配置临时或预发目标。
- 默认项目脚本，或用户明确选择的 CDS 独立脚本；存量目标按其兼容合同处理。

调用：

```bash
curl -sS \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$CDS_HOST/api/releases/targets" \
  --data-binary @/tmp/cds-release-target.json
```

服务端会写入 `projectIdentity`。调用方不得伪造该字段。

### 阶段 5：执行发布前检查

先获取真实预览地址，再调用：

```bash
curl -sS \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$CDS_HOST/api/releases/branches/$BRANCH_ID/preflight" \
  --data "{\"targetId\":\"$TARGET_ID\",\"previewUrl\":\"$PREVIEW_URL\"}"
```

以下检查必须通过：

- 分支正在运行。
- commit 明确。
- 项目身份一致。
- 远端 `appPath` 是 Git 根目录，且 origin 与项目仓库一致；CDS 内置本机产物发布除外。
- 发布策略完整。
- SSH 目标可连接。
- 现有脚本可执行，或动态发布依赖可用。
- 新项目脚本必须存在于指定提交，正文语法有效，同提交 CI 成功；必须保存正文哈希，不用文件路径字符串哈希冒充。
- 非首次发布时，当前线上入口可访问。
- 有历史成功版本时，回滚版本可定位。

任何 blocking fail 都不发布。

### 阶段 6：发布、观察与验收

用户或明确获权的流程确认预检计划后，调用发布接口。持续消费 SSE 日志，至少展示连接、计划、执行、健康检查、记录五个阶段。静止等待超过 2 秒不合格。

发布成功后，从公网域名验证：

1. `/` 为 HTML 200。
2. 从真实 HTML 解析出的同源 JS/CSS 为 200、非空、MIME 合理。
3. `healthcheckUrl` 为 200。
4. 本次涉及的独立服务页面和健康端点为 200。
5. 运行记录的 commit、策略、脚本 SHA-256 与预检一致。

若动态发布的最终入口探测失败，CDS 会尝试自动恢复上一成功版本；必须在交付中报告恢复是否成功，不能只写“发布失败”。

### 阶段 7：归档错误目标

精确确认目标 ID 后调用：

```bash
curl -sS \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$CDS_HOST/api/releases/targets/$TARGET_ID/archive" \
  --data "{\"reason\":\"该目标不属于当前项目，保留事故证据后归档\"}"
```

归档后再次获取 `/api/releases/targets?project=...`，断言：

- `targets` 不再包含该 ID。
- `archivedTargets` 包含该 ID、原因、操作者和时间。
- 其他项目和其他活跃目标未变化。

## 端到端示例

### 示例 A：新项目默认使用项目脚本

输入：项目已提交 `cds-release.sh`，且同一完整提交 CI 已测试该文件并成功。

选择：

```json
{
  "mode": "project-script",
  "scriptFile": "cds-release.sh"
}
```

预期：Git blob 与远端该提交文件正文一致；同提交 CI、Bash 语法和 check 通过后 deploy；记录正文哈希，最终公网表面全绿后完成。

### 示例 B：存量 Compose 目标兼容（不得新建为默认）

输入：仓库检测到 `compose.yml`，远端仓库为 `/opt/example`。

选择：

```json
{
  "mode": "generated-compose",
  "composeFile": "compose.yml",
  "composeProject": "example-prod",
  "detectedFrom": ["compose.yml"]
}
```

预期：CDS 以完整 commit 在仓库同级 `.cds-releases/<targetId>/worktrees/<releaseId>` 创建隔离 worktree，动态执行 Compose，原子更新 `current/previous`，不要求项目新增发布脚本，也不污染仓库状态。

### 示例 C：存量静态目标兼容（不得新建为默认）

输入：Vite 项目，构建命令为 `pnpm install --frozen-lockfile && pnpm build`，产物为 `dist`。

选择：

```json
{
  "mode": "generated-static",
  "buildCommand": "pnpm install --frozen-lockfile && pnpm build",
  "artifactDirectory": "dist",
  "publicDirectory": "/opt/example-web",
  "detectedFrom": ["package.json", "pnpm-lock.yaml"]
}
```

预期：构建产物先进入非在线目录，校验 `index.html` 及其实际 JS/CSS，目录/文件权限归一为 `755/644`，再原子切换 `/opt/example-web/current`。

## 失败处理

| 失败 | 主要原因 | 下一动作 |
|---|---|---|
| `project_key_required` | 使用了全局 AI key | 为目标项目签发或获取项目级 Key 后重试 |
| `project-identity` fail | 目标身份快照与当前项目不一致 | 归档错误目标，重新从正确项目发现策略 |
| `remote-repository` fail | `appPath` 不是 Git 根、origin 属于其他系统或项目没绑定仓库 | 修正项目仓库身份和远端目录，禁止只改目标名称 |
| `remote_host_scope` | 项目级 Key 引用了未授权主机 | 由系统管理员先在该项目预置 RemoteHost |
| 动态依赖检查失败 | 远端缺 Git、Docker、Compose、Bash 或 Python 3 | 安装明确缺失依赖，或改用可信现有脚本 |
| HTML 入口资源缺失 | 静态构建产物不完整 | 停止切换，修构建配置；旧页面保持在线 |
| 发布后入口失败 | 新版不可用 | 检查自动恢复日志和上一版本公网证据 |

## 输出模板

```markdown
CDS 发布配置结果

- 项目：<projectId> / <repository>
- 分支与 commit：<branchId> / <full sha>
- 目标：<targetId> / <production domain>
- 策略：<project-script 默认 | managed-script 明确备选 | 旧模式存量兼容>
- 身份校验：<pass/fail + evidence>
- 预检：<pass/fail + first blocking reason>
- 发布：<not started/running/success/failed>
- 脚本证据：<sha256>
- 最终入口：<HTML, JS/CSS, API, specialized surface evidence>
- 回滚：<available/not available/auto-restored/failed>
- 归档：<none or archived target id + reason>
- 已知边界：<none or explicit debt>
```

## 质量自评

| 维度 | 分数 | 依据 |
|---|---:|---|
| 触发精度 | 9 | 覆盖正式发布、无脚本、动态脚本、跨项目和页面混乱 |
| 可执行性 | 9 | 给出发现、配置、预检、发布、验收、归档完整 API 链 |
| 安全性 | 10 | 项目级 Key、身份锁定、不可变 commit、归档代替直接删除 |
| 完整性 | 9 | 三类策略、三个端到端示例、失败矩阵与输出模板 |
| 可维护性 | 8 | API 合同集中在 reference，策略事实由服务端 discovery 提供 |

总分：45/50。达到 8/10 以上质量门槛。
