# CDS DeepAudit 代码审查使用与维护 · 指南

> **版本**：v1.0 | **日期**：2026-11-10 | **状态**：功能已部署，部分路径仍待验收

**一句话**：从 CDS 提交源码或选平台分支，用 DeepAudit（开源代码审查引擎）审查并在同一任务中阅读真实结果。
**谁该读**：发起审查的用户、配置 MCP 的开发者和负责模型/部署的管理员。
**读完能做什么**：选择正确入口、理解覆盖与费用、找到失败原因，并区分已上线能力和仍未完成的要求。

## 当前能用到什么程度

入口是 [CDS 代码审查](https://miduo.org/code-reviews)。DeepAudit 是独立开源引擎，CDS 管来源、任务、权限和报告，LLMGW 管模型凭据与用量。这里不使用另一套 `/cds-agent` 官方 SDK 工作台；两者名称相近，但不是同一条审查链路。

小项目的 OpenAI 用户 Key 链路已有真实执行证据；代码审查界面与本地 MCP 已具备。不能据此承诺所有要求已经验收：当前 SMTP 未配置，其他三家供应商未用真实 Key 测试，`prd_agent` 的大仓审查尚未完成。详细状态见[需求兑现台账](./plan.cds.code-review-delivery.md)和[阶段验收报告](https://miduo.org/reports?project=prd-agent&folder=42c9eeebd2ea454e8c5e5d3e810da125&report=21a22c30954c407d85c64cd4715945da)（需 CDS 登录）。

## 网页操作

1. 打开 CDS 控制台，点击左侧《代码审查报告》。列表区分源码审查、导入文档和全部；默认会折叠历史执行，点击“全部执行（含历史）”查看历史。
2. 点击“发起审查”，在两个来源页签中选择一种。

| 来源 | 要提供什么 | 固定版本的方法 |
|---|---|---|
| 上传源码 / ZIP | 本机 ZIP，可选排除模式 | 服务端保存上传快照的 SHA-256 |
| 上传源码 / GitHub 地址 | 仓库地址，可选分支、标签或提交 | 准备源码时记录实际 Git 提交；私有仓库需要已有授权 |
| 平台项目 | CDS 中已有的项目和登记分支 | 准备时同步并固定该分支提交，不包含工作区未提交修改 |

3. 在“更多选项”选择平台额度或用户 Key；用户 Key 需要供应商、模型、Key 和保护额度，详见[专项指南](./guide.cds.code-review-user-key.md)。没有可靠价格时费用为未知。
4. 默认归档报告中心；只有显式选择邮箱且管理员已配置 SMTP 才额外发信。当前现场 `mailConfigured=false`，邮件不属于已经可交付的通路。
5. 核对范围和可能的模型消费后确认开始。提交成功只是创建后台任务，不是审查已经结束。
6. 阅读任务进度和结果。失败任务的重试可能继续产生用量；取消后保留的部分结果仍不能代表整个范围已完成。

上传已有报告使用“导入报告”。HTML/Markdown 原文保存后直接阅读，不会因此生成一份真实的源码审查或新的问题结论。功能验收报告应归入 CDS 验收报告中心，不应伪装成源码审查结果。

## 怎样读懂“到底审查了什么”

| 信息 | 正确解释 |
|---|---|
| 已分析 / 候选文件 | 必须与固定快照、排除和跳过说明一起读；候选不等于整个仓库所有文件 |
| 完成 | 本次执行范围结束，不表示代码质量通过 |
| 部分完成、失败或取消 | 已有发现可以复核，但未分析范围没有结论 |
| 严重度与五维分类 | 工具/AI 给出的候选判断，未经动态验证或人工复核不能当作已确认漏洞 |
| 代码片段或原因缺失 | 原始结果未提供时如实显示缺失，不补写假证据 |
| 原始报告 | 保留服务端保存的文档；HTML 脚本、外部资源和表单受 CSP/沙箱限制 |
| 检查覆盖 | 说明实际工具、跳过项和未执行项；不能将未执行的 Semgrep 写成通过 |

已知样例：`tiny.zip` 的真实 OpenAI 任务 `0ba69f4c4cd042fcbc703cb92113415d` 完成 1/1 文件。13 文件任务 `7a49d952b5f64e5fa3e6c6f3c46d9730` 仅是样本。大仓任务 `3ac77b6362f94898af21c6c3275fab2b` 为失败，已分析 1249/5475；没有覆盖全部自研模块的最终总报告。

## CLI 与 MCP

在目标 Git 项目中通过 CDS 接入流程取得项目级 `.cds/credentials.json`。不要手工把全局 Key 写入示例配置，也不要将凭据目录加入 ZIP。

```bash
python3 .claude/skills/cds/cli/cdscli.py code-review list --include-branches
python3 .claude/skills/cds/cli/cdscli.py code-review submit --branch-id prd-agent-main
python3 .claude/skills/cds/cli/cdscli.py code-review submit --zip-file source.zip --exclude 'vendor/**'
python3 .claude/skills/cds/cli/cdscli.py code-review submit --github https://github.com/owner/repo --ref main
python3 .claude/skills/cds/cli/cdscli.py code-review show TASK_ID --results --limit 50
python3 .claude/skills/cds/cli/cdscli.py code-review usage TASK_ID
python3 .claude/skills/cds/cli/cdscli.py code-review upload-report --file review.md --title '代码审查报告'
```

用户 Key 的 CLI 参数用环境变量名引用，如 `--user-key-env MY_OPENAI_API_KEY --provider openai --model gpt-4.1-mini --token-limit 30000`。不要把真实 Key 放进命令参数、Git、截图或报告。

安装桥接依赖后，在客户端配置本机绝对路径。客户端工作目录必须是已接入 CDS 的目标项目。

```json
{
  "mcpServers": {
    "cds-code-review": {
      "command": "node",
      "args": ["/absolute/path/prd_agent/cds/mcp/src/server.mjs"]
    }
  }
}
```

| 工具 | 用途 |
|---|---|
| `cds_code_review_submit` | 读取本机 ZIP 字节、GitHub 地址或已登记分支，创建审查 |
| `cds_code_review_get` | 读取进度、保存结果和投递状态，不重新扫描 |
| `cds_code_review_list` | 列出当前项目任务，可同时查询分支 |
| `cds_code_review_report_upload` | 读取本机已有 HTML/Markdown 并归档，不启动源码审查 |

本机路径必须在工作区内，桥接拒绝越界软链接和凭据目录；服务端不接受“去服务器读取这个路径”的请求。API 和网页遵守相同项目权限。重新执行失败任务只允许有权消费该 Key 的所有者。

## 管理与安全边界

| 项目 | 当前约束 |
|---|---|
| 开源与部署 | Fork 为 [inernoro/DeepAudit](https://github.com/inernoro/DeepAudit)，保留上游关联与 AGPL-3.0；CDS 项目为 `f9cd30ef1696` |
| 实际运行版本 | 核对时 DeepAudit 两条运行分支均为 `9063228981a6084dd017654f18ebb6a3eb966692`，使用 PostgreSQL、Redis 和持久卷 |
| 引擎绑定 | 只保存服务地址与项目/分支/服务引用，专用服务账号从引擎项目环境读取；业务任务不保存服务密码 |
| 执行安全 | 当前 CDS 集成是静态与 AI 分析，不执行上传项目安装/构建/启动脚本；CDS 部署合同未挂宿主 Docker socket |
| 输入限制 | ZIP 100MiB、解压 1GiB、20000 条目、单文件 200KiB；实际支持的源码扩展名、敏感路径和跳过项以报告为准 |
| 费用 | 历史线上 OpenAI 样例一次调用，1110 输入、732 输出，合计1842 Token；金额未知。此值不是全仓成本或供应商账号余额 |
| 自动门禁 | 代码审查报告独立分类，不自动决定验收通过率、发布或合并；本轮功能验收报告也不是源码质量结论 |
| 匿名分享 | 默认登录态阅读，不自动生成对外分享链接 |

详细实现可查[源码快照与校验](../cds/src/services/code-review-source.ts)、[引擎适配](../cds/src/services/code-review-engine.ts)、[引擎绑定](../cds/src/services/code-review-settings.ts)、[邮件适配](../cds/src/services/code-review-mail.ts)、[MCP桥接](../cds/mcp/src/server.mjs)。仅有这些代码不能替代生产验收。

## 版本与排障

- 核对时 CDS 正在运行 `e4b621b64`，双滚动/排版修复已经线上验证；视口高度单位循环修复进入了 [PR1936](https://github.com/inernoro/prd_agent/pull/1936)，合并提交为 `018eb4001`。没有生产更新证据前，不能把它写成已上线。
- 字体遵循平台 80/85/100 密度，不随窗口宽度额外整体放大；英文和标识符分别使用 Inter 与 JetBrains Mono，中文仍有系统回退差异，见[字体欠账](./debt.cds.md)。
- 原始 HTML 在独立 iframe 中阅读，普通长文档随外层滚动，超出既有 100000px 上限的文档保留原生回退。macOS 实体触控板和其他浏览器仍需独立验证。
- 模型服务不可用应显示明确失败与已有覆盖；不要反复重试来“证明完成”。重新分析、继续未完成范围和更换模型都应重新核对预算。
- 邮件不可用先检查 SMTP 配置；投递失败只重试邮件，不能重新扫描来发送同一报告。
- 本轮记录了旧分支备用节点测试的重复超时，主干同树 CI 通过；该风险不应被抹成“所有历史 CI 全绿”。
