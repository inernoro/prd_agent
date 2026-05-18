# CDS Agent sidecar 侵入 MAP 分支服务 · 调查报告

> 日期：2026-05-18  
> 结论级别：结构性问题，不是单次部署失误  
> 当前状态：仓库侧已移除 branch-local sidecar 并加防复发 guard；2026-05-18 最新只读复核确认远程 CDS state 仍有 7 个 `prd-agent` branch 保留 `claude-agent-sdk-runtime-v2-prd-agent`，需要单独清理旧 BuildProfile/branch services

## 一句话结论

`claude-agent-sdk-runtime-v2` 之所以反复“侵犯”主系统 MAP，是因为它被写进了 `prd-agent` 项目的 `cds-compose.yml` 普通 `services`，随后被 CDS 解析成项目级 `BuildProfile`。CDS 的 branch deploy 设计会对每个分支部署该项目的所有 BuildProfile，因此 sidecar 被当成 `api/admin` 一样的普通应用服务，进入 `main`、Claude 分支、Cursor 分支和当前 Codex 分支。

这不是 `claude-agent-sdk` 官方 SDK 本身的问题，而是 MAP/CDS 控制面把“代码审查 runtime sidecar”放错了结构层：它应该是隔离的 shared-service runtime pool 或外部 execution pool，不应该是 `prd-agent` 应用项目的 branch service。

## 现场证据

远程命令：

```bash
CDS_HOST=https://cds.miduo.org python3 .claude/skills/cds/cli/cdscli.py branch list --project prd-agent
```

关键结果：

| Branch | 状态 | sidecar 服务 |
| --- | --- | --- |
| `prd-agent-main` | `error` | `claude-agent-sdk-runtime-v2-prd-agent :10682`，ready 探测超时 |
| `prd-agent-codex-cds-agent-workbench-ui` | `running` | `claude-agent-sdk-runtime-v2-prd-agent :10676`，running |
| `prd-agent-claude-great-keller-htqwh` | `error` | `claude-agent-sdk-runtime-v2-prd-agent :10681`，ready 探测超时 |
| `prd-agent-claude-sync-sidebar-user-names-fslel` | `error` | `claude-agent-sdk-runtime-v2-prd-agent :10694`，部署被 CDS 重启中断 |
| 多个 idle/stopped 分支 | `idle` | `deployRuntime.activeProfiles=3` 仍把 sidecar 算进项目服务 |

同时，项目列表显示独立的 shared-service 项目存在但没有承载实例：

```text
shared-sidecar-pool-mp4anabh Claude SDK Sidecar Pool br=0 run=0 lastDeploy=None
```

这说明系统里已经有正确的“shared-service sidecar pool”概念，但当前 `prd-agent` 实际运行仍把 sidecar 放在应用分支服务里。

最新复核命令：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 \
  bash scripts/smoke-cds-agent-branch-isolation.sh
```

2026-05-18 复核结果：

- 本地 `cds-compose.yml` 已通过：未声明 branch-local sidecar service。
- 本地 `api.environment` 已通过：未配置 `CLAUDE_SIDECAR_BASE_URL=http://claude-agent-sdk-runtime...` 或 `CLAUDE_SIDECAR_TOKEN=dev-skip`。
- 远程 CDS state 未通过：`prd-agent-main`、`prd-agent-codex-cds-agent-workbench-ui`、`prd-agent-claude-redesign-ui-layout-awndl`、`prd-agent-claude-fix-gallery-stats-csu9h`、`prd-agent-claude-great-keller-htqwh`、`prd-agent-cursor-marking-line-agent-e307`、`prd-agent-claude-sync-sidebar-user-names-fslel` 仍包含 `claude-agent-sdk-runtime-v2-prd-agent`。

因此截图中的红框不是本地 compose 再次回退，而是远程 CDS state 中的历史 BuildProfile/branch service 残留仍在被页面展示和部署流程消费。

## 代码证据

### 1. sidecar 被写进 prd-agent 的普通 compose service

文件：`cds-compose.yml`

```yaml
services:
  api:
    environment:
      CLAUDE_SIDECAR_BASE_URL: "http://claude-agent-sdk-runtime-v2-prd-agent:7400"
      CLAUDE_SIDECAR_TOKEN: "dev-skip"

  claude-agent-sdk-runtime-v2:
    image: python:3.12-slim
    working_dir: /app
    volumes:
      - ./claude-sdk-sidecar:/app
    ports:
      - "7400"
    command: uvicorn app.main:app --host 0.0.0.0 --port 7400
```

这会被 CDS Compose 解析为 BuildProfile，并由 `importCdsComposeFromFile()` 追加项目后缀：

```ts
id: `${candidate.id}${idSuffix}`,
projectId: project.id,
```

因此最终 profile 变成：

```text
claude-agent-sdk-runtime-v2-prd-agent
```

### 2. CDS branch deploy 会部署项目下所有 BuildProfile

文件：`cds/src/routes/branches.ts`

```ts
const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
```

后续会为每个 profile 预分配 service：

```ts
entry.services[profile.id] = {
  profileId: profile.id,
  containerName: `cds-${id}-${profile.id}`,
  hostPort,
  status: 'idle',
};
```

所以只要 sidecar 是项目 BuildProfile，每个分支都会继承它。

### 3. 页面卡片并非误报

分支列表 `deployRuntime` 也是按项目 BuildProfile 计算：

```ts
summarizeBranchDeployRuntime(
  b,
  stateService.getBuildProfilesForProject(b.projectId || 'default'),
)
```

因此即使某些旧分支 `services` 里暂时没有 sidecar，卡片仍会显示 `activeProfiles=3`，因为项目层事实源已经包含 sidecar profile。

## 为什么反复出现

### 原因 1：把两种生命周期混成一个层

`api/admin` 是 MAP 应用分支服务，应该随每个 branch preview 生命周期启动/停止。

`claude-agent-sdk-runtime-v2` 是代码审查 runtime pool，应该是共享执行池或专用隔离 runtime，不应该随每个业务分支复制。

现在两者都位于 `cds-compose.yml services`，CDS 无法从结构上区分“应用服务”和“runtime sidecar”。

### 原因 2：为了修 R0 discovery，把 sidecar 旁路塞回应用分支

`api` 环境里写了：

```yaml
CLAUDE_SIDECAR_BASE_URL: "http://claude-agent-sdk-runtime-v2-prd-agent:7400"
```

注释里说这是“共享 CDS discovery 为空时”的 preview 内置 fallback。这个 fallback 临时修复了 R0，但代价是把 runtime sidecar 重新绑定到每个 MAP branch。

这是典型的局部修复扩大了结构污染面。

### 原因 3：shared-service 模型存在，但没有成为唯一入口

系统已有 `shared-service` 项目类型、long token、`/api/projects/:id/instances` discovery，以及 `shared-sidecar-pool-*` 项目。但当前实际 `prd-agent` 仍依赖 branch-local sidecar profile。

也就是说正确结构没有被强制使用，错误结构没有被禁止。

### 原因 4：缺少禁止性 guardrail

当前没有测试或导入校验阻止以下情况：

- `prd-agent` git 项目的 BuildProfile id/name 包含 `claude-agent-sdk-runtime`。
- `cds-compose.yml` 把 agent runtime sidecar 写成普通 `services`。
- `main` 分支或非 CDS Agent 分支出现 sidecar service。
- `deployRuntime.activeProfiles` 把 sidecar 算作应用服务。

所以每次“修复发现/路由/运行态”时，都可能重新把 sidecar 塞回项目 profile。

## 哪个结构出了问题

出问题的不是单个函数，而是边界模型：

| 层 | 现在的问题 | 正确边界 |
| --- | --- | --- |
| `cds-compose.yml` | sidecar 与 `api/admin` 同级 | 只描述应用服务；runtime sidecar 不进普通 services |
| BuildProfile | sidecar 被建成 `prd-agent` 项目 profile | sidecar 应属于 shared-service 或 runtime pool |
| Branch deploy | 每个分支部署所有 project profiles | 应用分支只部署 app profiles |
| Discovery fallback | API 直连 branch-local sidecar | API 只通过 shared-service discovery 或显式外部 sidecar |
| UI 卡片 | 把 sidecar 当应用端口展示 | runtime pool 应另有独立状态区 |
| 验证 | 只验证 R0 能发现 sidecar | 还要验证 main/业务分支不含 sidecar service |

## 影响

1. 主系统 `main` 多出 runtime 容器，部署失败会把主系统卡片标红。
2. 每个业务分支多启动一个 Python sidecar，增加端口、内存、构建时间和失败面。
3. sidecar ready 失败会和 `api/admin` 失败混在同一条 branch error 里，误导排障。
4. `deployRuntime.activeProfiles=3` 让用户误以为 MAP 应用本身有 3 个服务。
5. 代码审查 runtime 的生命周期被业务 preview 绑定，违背“MAP/CDS 只保留控制面，runtime pool 独立”的目标。

## 修复方向

### P0 立即止血

1. 从 `cds-compose.yml services` 移除 `claude-agent-sdk-runtime-v2`。
2. 从 `api.environment` 移除 branch-local：

```text
CLAUDE_SIDECAR_BASE_URL=http://claude-agent-sdk-runtime-v2-prd-agent:7400
CLAUDE_SIDECAR_TOKEN=dev-skip
```

3. 清理 CDS 远程 `prd-agent` 项目的 sidecar BuildProfile。
4. 对已有 branch services 清理 `claude-agent-sdk-runtime-v2-prd-agent` 的 stopped/error/running 记录和容器。
5. 保留 `/cds-agent` 通过 shared-service discovery 找 runtime pool；找不到时 R0 应明确 pending，而不是自动在应用分支里塞 sidecar。

仓库侧止血已落地：

- `cds-compose.yml` 已移除 branch-local `claude-agent-sdk-runtime-v2` service。
- `api.environment` 已移除 `CLAUDE_SIDECAR_BASE_URL=http://claude-agent-sdk-runtime-v2...` 和 `CLAUDE_SIDECAR_TOKEN=dev-skip` 静态旁路。
- 新增 `scripts/smoke-cds-agent-branch-isolation.sh`，默认做本地防复发检查；设置 `SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 CDS_HOST=...` 后可审计远程 branch services。
- 新增 `scripts/repair-cds-agent-branch-isolation.sh`，默认 dry-run 列出受影响分支与候选删除 BuildProfile；设置 `SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1` 后才会调用 CDS 删除 API。

注意：这些改动阻止后续复发，但不会自动清理 CDS 远程已经存在的 BuildProfile、branch service 记录和容器。远程清理必须作为单独运维动作执行并验收。

### P1 结构修复

1. 建立唯一 sidecar pool：

```text
Project.kind = shared-service
name = Claude SDK Sidecar Pool
```

2. MAP 只通过 long-token discovery 调：

```text
GET /api/projects/{sharedServiceProjectId}/instances
```

3. `prd-agent` 应用项目只保留：

```text
api-prd-agent
admin-prd-agent
```

4. CDS Agent 页面显示 runtime pool 状态，但不把 runtime pool 当成当前 branch 的 app service。

### P2 防复发 guardrails

新增自动化检查：

| 检查 | 失败条件 |
| --- | --- |
| Compose guard | `cds-compose.yml services` 出现 `claude-agent-sdk-runtime`、`sidecar` runtime 服务 |
| CDS state guard | `prd-agent` BuildProfile 出现 `claude-agent-sdk-runtime-v2-prd-agent` |
| Branch list guard | `prd-agent-main` 或非 CDS Agent branch `services` 包含 sidecar profile |
| UI guard | `deployRuntime.activeProfiles` 对 prd-agent 应用项目不应把 runtime sidecar 算入 |
| Discovery guard | R0 只能来自 shared-service discovery 或显式外部 sidecar，不能来自普通 app branch |

## 为什么不能继续保留 branch-local sidecar fallback

它看起来能让 `/cds-agent` 更容易跑通，但会持续破坏主系统：

- 每个 branch 都会复制 runtime。
- main 会被 runtime 失败拖红。
- 其他业务分支会被无关服务污染。
- 用户无法判断当前失败是 MAP 应用失败，还是代码审查 runtime 失败。
- 这和“保留 MAP/CDS 控制面，把自研 agent loop 压缩为官方 SDK adapter”的目标冲突。

正确做法是：R0 发现不到 shared-service runtime pool 时，就让 R0 pending，并给出修复命令；不要用污染应用分支的方式“补一个 sidecar”。

## 建议的下一步

1. 先做 P0 止血 PR：移除 `cds-compose.yml` 中 branch-local sidecar 和 API fallback env。
2. 写 `scripts/smoke-cds-agent-branch-isolation.sh`，远程断言：
   - `prd-agent-main.services` 不含 `claude-agent-sdk-runtime-v2-prd-agent`
   - 非 CDS Agent 分支不含 sidecar service
   - 当前 CDS Agent runtime pool 只能来自 shared-service discovery
3. 再做 P1：恢复并验证 `shared-sidecar-pool-*` 真实部署。
4. 最后重跑 one-cycle。若 R0 因共享 pool 未部署而 pending，这是正确失败；不要再把 sidecar 放回应用项目。

清理/恢复前后的只读控制面验收：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 \
  bash scripts/smoke-cds-agent-shared-service-pool.sh
```

该脚本会同时验证 `prd-agent` 不再携带 branch-local sidecar、`shared-sidecar-pool-*` 仍是 `shared-service`、CDS 是否登记了 enabled remote host，以及共享 runtime pool 是否有 running 实例。它不执行删除、重启或部署。

查看当前恢复顺序：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/plan-cds-agent-runtime-pool-recovery.sh
```

该计划脚本只读输出污染分支数、shared pool 状态、remote host 数量和下一步动作，并明确禁止通过普通 branch deploy 恢复 shared-service runtime pool。

当前远程只读审计结果仍有 4 个分支受影响，候选删除 BuildProfile 为：

```text
claude-agent-sdk-runtime-v2-prd-agent
```

执行清理命令：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 \
  bash scripts/repair-cds-agent-branch-isolation.sh
```

执行后必须复查：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 \
  bash scripts/smoke-cds-agent-branch-isolation.sh
```
