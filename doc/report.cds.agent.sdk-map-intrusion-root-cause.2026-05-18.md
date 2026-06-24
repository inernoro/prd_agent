# Claude Agent SDK 容器侵入 MAP 主系统 · 根因报告

> 日期：2026-05-18  
> 范围：`prd-agent` 业务项目、MAP runtime discovery、CDS branch deploy、shared-service runtime pool  
> 结论级别：结构性隔离失败，不是官方 SDK 本身问题，也不是页面误报。

## 一句话结论

`claude-agent-sdk-runtime-v2-prd-agent` 反复出现在 `main` 和多个业务分支，是因为它曾被写成 `prd-agent` 业务项目的普通 `BuildProfile` / branch service。CDS 的分支部署机制会把同一项目下的所有 `BuildProfile` 分配给每个 branch，所以 agent runtime 一旦进入业务项目，就会像 `api/admin` 一样复制到 `main`、Claude 分支、Cursor 分支和 Codex 分支。

官方 `claude-agent-sdk` 不是问题本身。问题是 MAP/CDS 的资源边界曾经把“系统级 agent runtime pool”放进了“业务分支 preview service”生命周期。

## 当前现场

截图里红框标出的服务是：

```text
claude-agent-sdk-runtime-v2-prd-agent
```

这不是一个应该跟随 `prd-agent-main` 或业务 feature branch 启停的应用服务。它应该属于 `shared-sidecar-pool-*` 这类 shared-service runtime pool。

截图调查当时的只读证据显示：

- `BRANCH_LOCAL_SIDECAR_CLEAN = contaminated:4`
- `REMOTE_HOST_AVAILABLE = missing`
- `SHARED_POOL_RUNNING = missing`
- 候选污染 profile：`claude-agent-sdk-runtime-v2-prd-agent`
- `shared-sidecar-pool-mp4anabh` 存在，但没有 running service。

2026-05-18 17:22 经用户精确批准后，已删除远程 `claude-agent-sdk-runtime-v2-prd-agent` BuildProfile 并同步清理受影响 branch services。最新有效状态变为：

- `BRANCH_LOCAL_SIDECAR_CLEAN = pass`
- `REMOTE_HOST_AVAILABLE = missing`
- `SHARED_POOL_RUNNING = missing`
- `contaminatedBranchCount = 0`
- 下一步不是普通 preview redeploy，而是登记 enabled remote host 并部署 shared official SDK runtime。

证据目录：

```text
/tmp/cds-agent-branch-isolation-repair-apply-current
/tmp/cds-agent-runtime-pool-evidence-latest
```

当前进度面板：

```text
doc/status.cds-agent-current-progress.md
```

## 为什么又出现

这次“又出现”不是因为本地 compose 再次写回了 sidecar。仓库侧已经补了本地防线：

- `cds-compose.yml` 不再声明 branch-local sidecar service。
- API 环境不再静态指向 `http://claude-agent-sdk-runtime...`。
- compose parser 已跳过 `claude-agent-sdk-runtime`、`claude-sidecar`、`claude-sdk-sidecar` 等 runtime sidecar 服务。
- StateService 已拒绝非 `shared-service` 项目写入 runtime-looking `BuildProfile`。

它仍然出现在页面，是因为远程 CDS state 里还保存着历史污染：

```text
prd-agent project BuildProfile/service residual
  -> claude-agent-sdk-runtime-v2-prd-agent
  -> 被 branch list / deployRuntime / branch deploy 继续消费
```

所以页面不是误报。页面展示的是远程控制面真实状态。

## 为什么屡被侵犯

### 1. 资源模型混淆

正确模型应该是：

```text
MAP / prd-agent
  session、profile、审批、事件、日志、取消、workspace 上下文

CDS shared-service runtime pool
  official SDK runtime instance

Claude Agent SDK
  agent loop、tool loop、模型交互
```

错误模型曾经是：

```text
prd-agent branch service
  api
  admin
  claude-agent-sdk-runtime-v2-prd-agent
```

一旦 sidecar 被纳入业务项目，所有 branch preview 都会继承它。

### 2. 修 R0 的局部 fallback 扩大了污染面

之前为了让 MAP 能发现 runtime，曾经允许 API 直连 branch-local sidecar alias。这个路径短期让 R0 能跑，但代价是把 runtime 重新绑到每个业务分支。

这类修复只解决“能不能找到 sidecar”，没有解决“sidecar 属于哪个生命周期”。

### 3. 只有正向可用性检查，缺少负向禁止门禁

过去更多验证的是：

```text
runtime 能不能启动
MAP 能不能发现
页面有没有显示
```

缺少强制验证：

```text
prd-agent/main 不允许出现 claude-agent-sdk-runtime
业务项目 BuildProfile 不允许出现 runtime sidecar
branch deploy 不允许把 shared runtime 当 app service
runtime pool 必须来自 shared-service 或显式外部 executor
```

现在这些 guard 已开始补齐，但远程历史 state 仍需单独清理。

### 4. 恢复顺序曾经不闭环

只改代码、只 redeploy preview、只刷新页面，都不能删除远程控制面里的历史 `BuildProfile`。

正确顺序必须是：

```text
清 branch-local residual
  -> 恢复 remote host
  -> 部署 shared official SDK runtime
  -> runtime-status / R0 / S1-S3 / one-cycle 验收
```

如果跳过第一步继续部署，就会继续在同一个污染状态上调试。

## 哪个结构出问题

核心问题是 runtime ownership boundary。

| 结构层 | 出错状态 | 正确状态 |
| --- | --- | --- |
| `cds-compose.yml` | runtime sidecar 曾和 `api/admin` 同级 | compose 只描述业务应用服务 |
| `BuildProfile` | sidecar 成为 `prd-agent` 项目 profile | runtime profile 只属于 `shared-service` |
| Branch deploy | 每个 branch 部署项目全部 profile | 业务 branch 只部署 app profiles |
| Discovery | MAP 可能直连 branch-local alias | MAP 通过 shared-service discovery 或显式外部 executor |
| UI | sidecar 显示在 branch app services | runtime pool 独立显示为基础设施状态 |
| 验收 | 只看 runtime 可用 | 同时验证 branch-local sidecar 不存在 |

## 代码证据

### Branch deploy 消费项目 BuildProfile

`cds/src/routes/branches.ts` 在 deploy 时按 branch 所属 project 取 profiles：

```ts
const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
```

因此只要 `claude-agent-sdk-runtime-v2-prd-agent` 存在于 `prd-agent` 项目 BuildProfile，它就会被分支部署流程消费。

### 分支卡片 deployRuntime 也从项目 BuildProfile 汇总

`cds/src/routes/branches.ts` 分支列表会把 project profiles 汇总进 `deployRuntime`：

```ts
summarizeBranchDeployRuntime(
  b,
  stateService.getBuildProfilesForProject(b.projectId || 'default'),
)
```

所以截图里不是纯 UI 幻觉，而是 UI 读到了控制面里的污染事实。

### 现在已补 compose parser 防线

`cds/src/services/compose-parser.ts` 已跳过 agent runtime sidecar：

```ts
if (isAgentRuntimeSidecarService(serviceId, entry)) {
  continue;
}
```

识别条件包括：

```text
claude-agent-sdk-runtime
claude-sidecar
claude-sdk-sidecar
SIDECAR_AGENT_ADAPTER=claude-agent-sdk
```

### 现在已补 StateService 中心写入防线

`cds/src/services/state.ts` 在新增或更新 `BuildProfile` 时调用：

```ts
this.assertBuildProfileRuntimeBoundary(profile);
```

非 `shared-service` 项目里如果 profile 看起来是 Claude Agent SDK runtime sidecar，会抛错：

```text
agent runtime 必须由 CDS shared-service runtime pool 管理，不能写入业务项目 BuildProfile。
```

这能阻止新的代码路径再次污染业务项目，但不会自动删除远程旧数据。

## 已经做对的事

- 本地 compose guard 已有：`scripts/smoke-cds-agent-branch-isolation.sh`
- 旧 branch-local alias 探测已默认关闭：`scripts/smoke-cds-agent-sidecar-alias-stability.sh` 和 `scripts/doctor-cds-agent-runtime.sh` 只有显式设置 `SMOKE_CDS_AGENT_ALLOW_BRANCH_LOCAL_ALIAS_PROBE=1` 才会访问历史污染别名。
- 远程污染 dry-run 已有：`scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh`
- 远程 host / shared pool evidence 已有：`scripts/collect-cds-agent-runtime-pool-evidence.sh`
- 当前进度文档已沉淀：`doc/status.cds-agent-current-progress.md`
- 结构性报告已沉淀：`doc/report.cds-agent-runtime-pool-contamination-2026-05-18.md`
- 这份根因报告专门解释“为什么反复侵入 MAP 主系统”。

## 还没闭环的事

当前仍未完成：

1. 删除远程 `prd-agent` 业务项目中的历史污染 profile：

```text
claude-agent-sdk-runtime-v2-prd-agent
```

2. 登记 enabled remote host。
3. 在 shared-service pool 部署 official SDK runtime sidecar。
4. 跑 runtime-status、R0、S1/S2/S3、one-cycle 验收。

## 推荐修复顺序

不要先做普通 preview redeploy。先做 R0 runtime pool recovery。

### Step 1：只读复核

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
  bash scripts/collect-cds-agent-runtime-pool-evidence.sh
```

### Step 2：清理 branch-local residual

必须通过 evidence wrapper，并精确确认唯一候选 profile：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=claude-agent-sdk-runtime-v2-prd-agent \
  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh
```

执行后验收目标：

```text
BRANCH_LOCAL_SIDECAR_CLEAN = clean
beforeContaminatedBranchCount > 0
afterContaminatedBranchCount = 0
verdict = applied-clean
```

### Step 3：恢复 shared-service runtime pool

清理干净后再登记 remote host，并部署 official SDK runtime sidecar。否则 shared pool 和 branch-local sidecar 会继续混在一起。

### Step 4：最终验收

必须同时通过：

```text
BRANCH_LOCAL_SIDECAR_CLEAN = clean
REMOTE_HOST_AVAILABLE = available
SHARED_POOL_RUNNING = running
MAP runtime-status 可发现 healthy official SDK sidecar
R0/S1/S2/S3/one-cycle 通过
```

## 防止第四次复发的硬性规则

1. `prd-agent` 业务项目永远不能有 `claude-agent-sdk-runtime*` / `claude-sidecar*` BuildProfile。
2. `cds-compose.yml services` 不能声明 agent runtime sidecar。
3. MAP 默认不能指向 branch-local `CLAUDE_SIDECAR_BASE_URL`。
4. shared-service pool 不可用时，状态应显示 R0 blocked，而不是悄悄塞一个 branch-local sidecar。
5. 所有 runtime 修复必须有 evidence wrapper、pre-check、post-check、耗时记录。
6. 页面要把 branch app services 和 runtime pool services 分开展示，不能混成一个端口列表。

## 责任归因

这不是 Claude Agent SDK 官方容器“主动侵犯”MAP。它只是被错误接入到了业务 branch lifecycle。

真正的问题是：

```text
control plane / app preview / runtime execution pool 三个边界没有被强制建模。
```

现在代码层已经开始补禁止性 guard，但远程状态清理和 shared pool 恢复还没闭环。闭环前，截图里这种污染仍会继续出现。
