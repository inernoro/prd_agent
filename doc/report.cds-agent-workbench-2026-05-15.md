# CDS Agent 工作台完成复盘 · 报告

> **版本**：v1.0 | **日期**：2026-05-15 | **状态**：已落地

## 一句话结论

CDS Agent 工作台已经从“连接探活页面”推进到“可由 MAP 统一配置、启动远程 sandbox、流式对话、审批工具、回看日志和产物、操作远程浏览器、接入工作流与智能体，并最终让远程 Agent 巡检本仓库提交 PR”的完整闭环。

最终验收以 A10 为准：远程 CDS Agent 使用真实模型、真实 shared sidecar、真实 `repo_*` 工具和 GitHub 凭据，在 `prd_agent` 仓库中发现测试覆盖缺口，补了 11 个回归测试，跑通 55 个相关测试，并创建 Draft PR #617。

PR 地址：`https://github.com/inernoro/prd_agent/pull/617`

## 新增了哪些能力

| 能力 | 用户能做什么 | 代表验收 |
|------|--------------|----------|
| 系统级 CDS 长期授权 | 管理员一次授权，长期复用，不再 10 分钟失效 | active connection `longTokenExpiresAt=2099-12-31T23:59:59Z` |
| 系统级模型运行档案 | 配置任意 OpenAI-compatible / Anthropic-compatible `baseUrl`、`model`、API key | OpenRouter `deepseek/deepseek-v4-pro` 正向生成通过 |
| CDS Agent 独立页 | 用户从百宝箱或首页进入远程 Agent 页面 | 真实入口视觉通过 |
| 远程会话生命周期 | 新建、启动、发送、停止、刷新恢复 | A10 会话完成后回写 `stopped` |
| 流式事件时间线 | 页面持续展示状态、文本、工具、日志、错误、完成事件 | A10 页面显示 500 条事件 |
| 工具审批 | 危险工具暂停等待人工允许或拒绝，刷新后仍可恢复 | A7 审批恢复验收 |
| 仓库工具 | 读文件、搜代码、列文件、看 status/diff、写文件、跑命令、创建 PR | A10 使用 `repo_*` 全链路 |
| 远程浏览器工具 | 读取页面快照、执行输入、点击、SPA 跳转并回传 browser 事件 | A6 Bridge 操作验收 |
| Hook 配置 | before/after start/stop 能生成事件并影响启动/停止策略 | P6 验收 |
| 日志与产物面板 | 文件树、diff、命令输出、测试结果、浏览器快照、运行日志可见 | P13/A10 视觉验收 |
| 工作流接入 | 工作流节点调用 CDS Agent，并把输出映射给后续节点 | A8 输出映射验收 |
| 智能体接入 | AI 百宝箱可以委托 CDS Agent 执行远程任务 | A9 智能体验收 |
| 系统级 sidecar pool | sidecar 属于 CDS 自托管基础设施，不再侵入业务 app profile | A11 迁移验收 |
| 可观测性 | traceId 串联 toolbox run、MAP session、CDS session、审批、工具事件 | A10 trace `toolbox-run-6a0618190b1a85ccd3e2e429` |
| 自巡检 PR 闭环 | 远程 Agent 真实改仓库、跑测试、推分支、开 PR | PR #617 |

## 最终用户路径

1. 进入 `https://main-prd-agent.miduo.org/`。
2. 从首页或左侧进入 `百宝箱`。
3. 点击 `CDS Agent`。
4. 选择 active CDS 连接。
5. 选择系统级模型配置，例如 OpenRouter DeepSeek V4 Pro。
6. 新建远程会话。
7. 发送任务。
8. 页面看到流式文本、工具调用、审批卡、日志和产物。
9. 对危险工具点击允许或拒绝。
10. Agent 完成后看到 PR 链接、测试结果和总结。
11. 点击停止或等待任务完成后释放 runtime。
12. 刷新页面，仍能回看完整事件。

这条路径已经在 A10 真实入口视觉中通过：`首页 -> 百宝箱 -> CDS Agent -> 选中 A10 已停止会话`。截图证据在 `.Codex/tmp/cds-agent-a10-pr-visual-2026-05-15.png`。

## A10 发生了什么

| 项 | 值 |
|----|----|
| Toolbox run | `6a0618190b1a85ccd3e2e429` |
| Trace | `toolbox-run-6a0618190b1a85ccd3e2e429` |
| MAP session | `5767a03899ba47d08bfb5ff629de9e5e` |
| CDS session | `cds-agent-9d333e31c3eb4feab2b0b4ff68e8c8bc` |
| Runtime | `claude-sdk` |
| Model | `deepseek/deepseek-v4-pro` |
| Base URL | 系统级 OpenAI-compatible 配置 |
| Sidecar | CDS shared sidecar pool |
| PR | `https://github.com/inernoro/prd_agent/pull/617` |
| Remote commit | `613969c` |
| Remote branch | `cx/cds-agent-a10-self-audit` |
| Test result | `Failed: 0, Passed: 55, Skipped: 0, Total: 55` |

远程 Agent 找到的真实缺口是：`ToolboxRunWorker.ResolveRunKind` 控制队列隔离，但此前没有回归测试。它新增 `ToolboxRunWorkerTests` 覆盖 project/branch slug、fallback 链、默认值和隔离 key，并把测试项目引用补齐。

## 你看到“还有 15 个任务没完成”的原因

这是计划文档演进中的账面偏差，不是最终能力缺失。

旧文档在 P10-P17 过程中曾同时维护三套清单：

| 清单 | 用途 | 问题 |
|------|------|------|
| P9-P17 阶段表 | 定义阶段能力 | 最终已更新为全勾选 |
| A1-A11 验收表 | 记录真正端到端验收 | A1-A11 已完成 |
| 早期 P15/P17 子项 | 开发中细拆 | 部分旧子项曾留着 `[ ]`，但后续 A2/A8/A9/A10 已覆盖 |

我原本的打算是：先按 A1-A11 真实跑通，不在每个旧小表上反复做账；等最终 A10 成功后再统一回填计划。问题是中间你看到文档时，旧小表还没被统一扫尾，就会显得“明明做了很多，但账面还有任务”。这是我的文档同步节奏问题。

现在新的结论是：

- P17.1-P17.10 已补齐为 `[x] [x] [x]`。
- A1-A11 已补齐为 `[x] [x] [x]`。
- Todo #15-#17 已补齐为 `[x]`。
- 仍有后续债务，但它们不是“完成标准未达成”，而是下一代增强项。

## 我的原本打算

我一开始不是想只做一个配置页。真正路线是：

1. 先证明 MAP 与 CDS 能长期授权，而不是 10 分钟临时连接。
2. 再证明 MAP 能创建会话、保存事件、停止释放。
3. 再从 fake runtime 切到真实 Claude SDK sidecar。
4. 再把模型配置抽成系统级 runtime profile，允许任意 `baseUrl` 和 `model`。
5. 再把危险工具、人审、日志、产物、刷新恢复补齐。
6. 再让工作流和 AI 百宝箱都能调用 CDS Agent。
7. 最后用这个 Agent 巡检 `prd_agent` 自己，并提交 PR。

这条路线最后走通了，但中间踩了很多坑，远比“加一个页面”复杂。

## 关键坑位

| 坑 | 表现 | 修复或结论 |
|----|------|------------|
| 10 分钟授权误判 | active 连接显示“已撤销”或不可用 | 只把 revoked 当授权失效，探活失败不再等于撤销；DataProtection key ring 持久化 |
| MAP 地址错 | CDS 授权页把 MAP 地址当成固定地址 | 回调地址必须使用跳转来源，而不是手填的本机地址 |
| 设置页入口缺失 | 用户找不到基础设施服务 | 补入口，后来又沉淀成独立 CDS Agent 页面 |
| 模型 key 混用 | 把 `AI_ACCESS_KEY` 当 provider key 导致 401 | 明确 `AI_ACCESS_KEY` 只管 MAP/CDS 管理认证，模型 provider key 单独配置 |
| sidecar 侵入业务项目 | `prd-agent` app profile 出现 api/admin/sidecar 三容器 | sidecar 迁到 CDS 系统侧 shared pool，业务项目保留 api/admin |
| 后台 worker 无 HTTP 上下文 | shared sidecar callback 退回内部 `api` 主机名，工具回调失败 | 从 CDS 注入的 repo/branch 推导公网 callback URL |
| Toolbox 队列串扰风险 | 不同项目/分支可能共用默认 queue key | `ResolveRunKind` 兜底 project/branch，A10 又补测试 |
| 视觉验收绕路风险 | API 通了但用户路径不通 | 强制从首页、百宝箱、设置等真实入口进页面 |
| 长命令公网 callback | 长 `repo_run_command` 可能被 Cloudflare 524 截断 | 当前短工具可用；下一步应让 shared sidecar 长命令优先走内网 callback |
| 计划文档老旧 | 新能力已完成，但旧段落仍显示未完成 | 本报告和新教程用于替代旧文档的“当前状态入口” |

## 不应该继续创建草稿的原则

PR #617 是 Draft，因为 A10 的提示里明确要求创建 draft PR。后续规则应该调整为：

- 不破坏主线、不触发线上行为、只增加测试或文档的 PR，默认创建 ready PR。
- 需要人工补密钥、需要用户确认产品取舍、可能影响生产数据的 PR，才创建 draft。
- 如果远程 Agent 已经跑通测试并且变更可审查，不应隐藏在 draft 状态里。

## 还没完成但应该交代的事

| 事项 | 严重度 | 为什么没做完 | 建议 |
|------|--------|--------------|------|
| 长命令内网 callback | medium | A10 已绕过但暴露 524 风险 | CDS 给 shared sidecar 注入 MAP internal callback base，长工具走内网 |
| 多 runtime adapter | medium | 当前主路径是 Claude SDK sidecar | 后续补 Codex/OpenAI Agents SDK/自定义容器 adapter |
| PR #617 转 ready | low | 原任务要求 draft | 若不破坏主线，下一步应把 PR 转 ready 或让后续 Agent 复核后转 ready |
| 会话列表历史清理 | low | 多轮验收产生很多运行中旧会话 | 增加批量停止、归档、按 trace 搜索 |
| 成本和用量面板 | low | 先保主链路 | 按 session 展示 tokens、运行时长、工具次数 |
| 自动验收回放 | medium | 目前视觉证据靠人工路径和截图 | 把 A10 路径固化成 Playwright/Bridge 回归套件 |

## 我想补给你的话

你真正要的不是“接上 Claude SDK”，而是把 MAP 变成一个可以指挥远程执行环境的操作系统。这个目标比一开始看起来大很多：它横跨授权、容器、模型、工具、审批、日志、PR、工作流、智能体和视觉验收。最难的部分不是写接口，而是每一层都不能骗自己：探活不是授权成功，API 200 不是用户能用，模型能回一句话不是 Agent 能干活，能开 PR 也不等于可审计。

这次真正突破的点，是 A10：它让这个系统第一次“用自己修自己”。这比页面上多几个按钮更有意义。

## 给下一个智能体的交接提示词

```text
你接手 prd_agent 的 CDS Agent 工作台。先读：
1. doc/report.cds-agent-workbench-2026-05-15.md
2. doc/guide.cds-agent-workbench-reproduce.md
3. doc/guide.cds-agent-next-agent-testing.md
4. doc/plan.cds-agent-workbench.md

当前基线：
- main 已部署到 CDS，预览为 https://main-prd-agent.miduo.org/
- CDS Agent 已完成 A10 验收：远程 sandbox 巡检 prd_agent 并创建 PR #617
- 系统级 CDS 长期授权、OpenAI-compatible runtime profile、shared sidecar pool、repo tools、Bridge tools、工具审批、工作流接入、AI 百宝箱接入都已跑通
- 不要把 AI_ACCESS_KEY 当模型 provider key
- 不要把设置页探活当最终验收
- 视觉验收必须从真实入口进入，不能直达路由替代
- 后续优先做长命令内网 callback、自动验收回放、PR ready 策略、会话清理和用量面板

你的任务：
1. 先复核 PR #617，若无破坏主线风险，把 draft 转为 ready 或补最小修复。
2. 设计并实现 shared sidecar 长命令内网 callback，避免公网 524。
3. 把 A10 真实路径固化为自动化验收脚本：从首页/百宝箱进入 CDS Agent，定位 A10 会话，断言 PR 链接、测试结果、事件、停止状态。
4. 每改一项都更新文档，跑冒烟和视觉验收，提交中文 commit，推 main 后确认 CDS running。
```
