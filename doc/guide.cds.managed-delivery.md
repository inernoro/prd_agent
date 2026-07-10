# CDS 托管交付 · 指南

> **版本**：v1.0 | **日期**：2026-07-10 | **状态**：开发中
>
> **目标读者**：使用 CDS 部署项目的开发者、测试人员和自动化 Agent

## 适用场景

本指南用于以下场景：

- 常规 Web、API 或 Worker 项目，希望减少 BuildProfile、端口、资源连接和重复构建的手工调试；
- 部署页面刷新、连接中断或 CDS 重启后，希望继续查看同一次部署的阶段和根因；
- 希望重新部署已验证版本或回滚旧版本，而不是重新拉代码、重新编译；
- 部署失败后，希望先得到稳定错误码、责任侧、重试条件和证据，再决定是否使用 AI 解释。

## 此次更新带来的变化

| 操作 | 更新前 | 更新后 | 直接收益 |
|------|--------|--------|----------|
| 配置常规项目 | 手写或维护 BuildProfile、端口、启动命令和资源连接 | 选择托管模式，CDS 检测技术栈并生成最终生效配置 | 减少配置自由度和调试分支 |
| 查看部署进度 | 页面 SSE、分支状态、日志和 OperationLog 分别推导 | 每次部署先创建唯一 `runId`，所有入口读取同一事实账本 | 刷新或断线后不丢上下文 |
| 判断失败根因 | 人工翻容器日志并猜责任侧 | 返回稳定错误码、责任侧、可重试性、建议动作和证据引用 | 先定位再修复，减少无效重试 |
| 重复部署 | 再次拉代码和构建 | 可复用版本直接启动不可变产物 | 缩短恢复时间，减少构建变量 |
| 回滚 | 重新解释旧 commit 和当前配置 | 选择历史 `DeploymentVersion` 直接回滚 | 回滚内容可证明、可追溯 |
| AI 诊断 | AI 可能直接猜原始日志 | AI 只解释脱敏后的结构化事实 | AI 不再充当部署事实源 |

同步主分支后，托管交付逻辑与主分支新增的 Webhook、活动记录、部署限流、归档限制和前端计时逻辑均被保留。状态存储改为异步写入后，`DeploymentRun` 的创建入口也同步改为等待持久化完成，继续保证“先记账，再产生部署副作用”。

## 模式选择

| 模式 | 推荐对象 | 需要维护什么 | 保留能力 |
|------|----------|--------------|----------|
| 托管模式 | 常规 Web、API、Worker | 应用目录、入口、健康路径、逻辑能力需求 | 自动技术栈检测、构建与启动分离、资源绑定、版本复用 |
| Compose 模式 | 特殊网络、多服务、自定义镜像或复杂启动拓扑 | 完整 compose、BuildProfile 和高级参数 | 现有全部高级控制能力 |

旧项目默认继续使用 Compose 模式。切换托管模式不是单向迁移；遇到平台暂不支持的特殊拓扑时，可以切回 Compose 模式，原配置继续生效。

## 快速开始

1. 打开 CDS 项目列表，进入目标项目的“设置”。
2. 打开“交付模式”页签，选择“托管模式”。
3. 首次使用保持 `apps` 和 `capabilities` 为空，让 CDS 自动扫描仓库；点击“保存并重新生成”。
4. 在“最终生效配置”核对应用目录、技术栈、构建命令、启动命令、端口、健康路径和资源绑定。
5. 返回分支列表，打开目标分支并执行部署；在分支详情中查看“部署事实账本”和“不可变部署版本”。

项目设置的最终深链格式为：

```text
/settings/{projectId}#delivery
```

## 页面操作演示

### 演示一：从 Compose 切到托管模式

1. 进入“项目设置 → 交付模式”。
2. 当前项目显示“Compose 模式”时，点击“托管模式”。
3. CDS 保存最小声明，并使用项目第一条已克隆分支检测技术栈。
4. 页面出现“最小声明”和“最终生效配置”。
5. 顶部提示“已启用托管模式并生成生效配置”。

预期变化：用户不再先写完整 BuildProfile，而是先核对 CDS 生成的配置；只有自动识别不准确时才补充最小声明。

### 演示二：刷新后继续追踪同一次部署

1. 在分支详情点击“重新部署”。
2. 记下“部署事实账本”显示的 `runId`、阶段和事件数。
3. 刷新页面或临时断开页面连接。
4. 再次打开同一分支。

预期变化：页面继续读取同一个 `runId`，并从已有事件序号之后恢复，不会把刷新后的连接误认为一次新部署。

### 演示三：复用版本与回滚

1. 完成一次成功部署。
2. 在“不可变部署版本”找到标记为“产物可复用”的版本。
3. 对当前版本点击“重新部署此版本”，或对历史版本点击“回滚到此版本”。
4. 查看新产生的 DeploymentRun。

预期变化：可复用版本直接启动既有产物，不重新拉取和编译源码；新 run 仍完整记录启动、验证和最终状态。

### 演示四：结构化失败诊断

1. 打开状态为“部署失败”的 run。
2. 先查看稳定错误码、责任侧、是否可重试、建议动作和证据引用。
3. 按建议修复代码、配置、CDS 或外部依赖。
4. 仅在需要大白话解释时点击“AI 解释”。

预期变化：确定性诊断不依赖 AI Gateway；未配置 AI 时，只影响解释增强，不影响错误分类和恢复建议。

## CLI 操作

以下示例假定已经配置 `CDS_HOST`、`AI_ACCESS_KEY`，并在需要时配置 `CDS_PROJECT_ID`。

### 查看部署事实账本

```bash
python3 .claude/skills/cds/cli/cdscli.py --human deployment-run list --project <projectId> --branch <branchId>
python3 .claude/skills/cds/cli/cdscli.py deployment-run show <runId>
python3 .claude/skills/cds/cli/cdscli.py deployment-run wait <runId> --timeout 300
```

`list` 用于快速判断最近部署状态，`show` 返回完整快照和事件，`wait` 适合脚本等待终态。

### 读取失败诊断

```bash
python3 .claude/skills/cds/cli/cdscli.py deployment-run diagnose <runId>
python3 .claude/skills/cds/cli/cdscli.py deployment-run diagnose <runId> --ai
```

第一条只读取确定性诊断；第二条通过 AI Gateway 流式解释同一组结构化事实。

### 查看和复用不可变版本

```bash
python3 .claude/skills/cds/cli/cdscli.py --human deployment-version list --project <projectId> --branch <branchId>
python3 .claude/skills/cds/cli/cdscli.py deployment-version show <versionId>
python3 .claude/skills/cds/cli/cdscli.py deployment-version deploy <versionId> --wait
```

只有所有服务产物均标记为可复用时，版本才能跳过源码构建。

### 回滚分支

```bash
python3 .claude/skills/cds/cli/cdscli.py branch rollback <branchId> --version <versionId> --wait
```

不传 `--version` 时，CDS 选择当前版本之前最近的可回滚版本。

## 验收清单

| 验收项 | 预期结果 |
|--------|----------|
| 切换托管模式 | 页面显示最小声明和最终生效配置，保存后出现成功提示 |
| 执行新部署 | 副作用发生前已经能查到 DeploymentRun |
| 刷新部署页面 | 同一 runId 的阶段与事件继续显示 |
| 同版本重新部署 | 可复用产物不重新构建，仍产生新的 run 记录 |
| 回滚历史版本 | 分支指向目标版本，新 run 记录回滚过程 |
| 制造构建失败 | 诊断显示错误码、责任侧、重试条件、建议动作和证据 |
| 未配置 AI Gateway | 确定性诊断可用，AI 入口明确提示未配置 |
| 切回 Compose | 原有 compose 与 BuildProfile 继续生效 |

## 常见问题

| 问题 | 解答 |
|------|------|
| 新命令或页面请求返回 404 | 当前 CDS 控制面仍运行旧版本。先合并并按发布流程更新控制面；不要反复修改项目配置规避 404。 |
| 托管模式没有生成应用 | 项目至少需要一条已克隆分支，或在 `apps` 中显式声明应用目录。 |
| 版本显示“仅记录” | 至少一个服务没有可复用产物；查看 `reuseBlockedReason`，按提示重新源码构建。 |
| 同节点版本能用，换执行器后不能用 | managed 本地产物目前属于执行器本地镜像；跨执行器搬运尚未实现，需要在目标执行器重新构建。 |
| AI 解释不可用 | 检查 AI Gateway 配置；确定性诊断不受影响。 |
| 项目需要特殊网络或复杂多服务拓扑 | 切回 Compose 模式，由项目维护完整拓扑。 |

## 激活边界

本功能当前位于 `codex/cds-managed-delivery` 分支和对应 PR 中。代码、测试与页面构建已经完成，但生产 CDS 控制面必须在 PR 合并后按正式发布流程更新，新的 API 和页面才会在生产入口生效。本次操作没有执行生产 CDS 自更新。

## 相关文档

- [CDS 托管交付契约 · 设计](design.cds.managed-delivery)
- [CDS 三种部署方式指南](guide.cds.deploy-three-paths)
- [CDS 可视化部署与验收指南](guide.cds.deploy-acceptance)
- [CDS CI 预构建债务台账](debt.cds.ci-prebuilt)
