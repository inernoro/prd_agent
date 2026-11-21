# CDS 代码审查 MCP

本地 stdio 桥接提供四个项目级工具，统一调用 CDS 代码审查 REST 接口。使用 Node 20.18.1 或更新版本。

同一仓库只需提交一次 ZIP 或 GitHub 地址，获得一个审查任务和一份最终报告。
文件在 DeepAudit 内部并行分析，可离开页面后从 CDS《代码审查报告》继续查看。
支持检查点的任务重试时保留已完成文件；实际覆盖、排除和未完成项以报告说明为准。

在本仓库安装依赖：

```bash
pnpm --dir cds/mcp install --frozen-lockfile
```

在待审项目目录运行 `cdscli connect`，获得 `.cds/credentials.json`。文件沿用 CLI 的版本 1 格式：
`version`、`host`、`projectId`、`projectKey`。项目凭据由安全接入流程写入，不复制到 MCP 配置。
桥接从客户端工作目录向上查找 Git 根，支持 Git worktree；忽略环境变量中的主机和凭据覆盖。

将以下启动信息添加到 MCP 客户端，并将工作目录设为待审项目：

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

Codex 支持显式设置工作目录：

```toml
[mcp_servers.cds-code-review]
command = "node"
args = ["/absolute/path/prd_agent/cds/mcp/src/server.mjs"]
cwd = "/absolute/path/project"
```

| 工具 | 输入 | 行为 |
|---|---|---|
| `cds_code_review_submit` | `zipPath`、`githubUrl` 或当前项目 `branchId`（三选一）；可选 `ref`、`excludePatterns`、`title`、`email`、`idempotencyKey` | 创建异步审查任务；显式提供邮箱才额外发信 |
| `cds_code_review_get` | `taskId`；可选 `offset`、`limit`、`severity`、`query` | 查询进度、结构化问题、覆盖范围、报告链接和投递状态；不触发分析 |
| `cds_code_review_list` | 可选 `includeBranches` | 查询凭据绑定项目的任务与报告关联；为 true 时附带可审查分支 ID 与名称 |
| `cds_code_review_report_upload` | `filePath`、`title`；可选 `idempotencyKey` | 上传已有 HTML/Markdown 报告，无需重新审查 |

工具发现读取 CDS `/api/code-reviews/capabilities` 的共享能力目录，只展示服务端登记的工具。
工具调用同样校验该目录；服务端未开放的工具不能调用。缺少目录、格式错误或版本不兼容时明确失败，
不会将本地工具定义当作后端已经支持的证据。客户端再次发现工具时刷新目录并撤销失效能力。

上传路径必须位于当前项目内，拒绝指向工作区外的软链接及 `.cds`、`.git` 目录。
ZIP 最大 100 MiB，报告最大 10 MiB。文件只在本机读取，以 multipart 字节上传；服务器不读取客户端路径。
所有报告默认受 CDS 项目权限保护，不开启匿名分享。通过任务返回的报告 ID 打开 CDS 报告阅读器。

查询结果保留原有 `task`，额外返回 `reportUrl` 和 `result`。`result.findings` 可直接用于定位文件、解释原因与生成修复建议；默认每页 50 条，使用 `result.page.nextOffset` 继续查询，统计与覆盖说明独立于当前页。所有引擎发现都保留未验证状态，不据此自动修改代码、合并或发布。

新审查在私有对象存储中保留结构化原始字段；旧版 CDS Markdown 能完整还原时提供已有问题字段。导入文档或不能完整还原的历史报告返回 `result: null` 与原因，并保留原文阅读入口，不伪造结构化扫描结果。

已停止的 DeepAudit 任务可以只读取既有问题并缓存到私有存储，不上传源码、不续跑、不调用模型，也不把失败状态改成完成。部分结果可下载为明确标注“未完成”的 Markdown；它不生成完成归档，不改变验收或发布结论。

HTTPS 为默认要求，只有回环地址允许 HTTP。网络请求沿用 HTTP(S)_PROXY、NO_PROXY 和 Node CA 信任；
不会跟随重定向传送项目凭据。错误中不返回凭据原文。

运行真实 stdio 客户端集成测试与语法检查：

```bash
pnpm --dir cds/mcp test
pnpm --dir cds/mcp check
```

首次读取较大的历史结果时，`cds_code_review_get` 会立即返回 `result: null, resultLoading: true`。继续按同一 taskId 查询，后台只整理引擎已有问题，完成后返回分页结果；不会恢复审查或改变失败状态。

直接审查 CDS 已连接的项目：先调用 `cds_code_review_list({"includeBranches":true})`，
用户选择返回的分支后调用 `cds_code_review_submit({"branchId":"所选分支ID"})`。
无需上传文件或填写 GitHub URL。准备源码时复用现有项目仓库授权，同步远端分支并固定 SHA；
审查不包含工作树未提交内容，不切换部署分支，也不运行项目脚本。`ref` 仅用于 GitHub 来源。

### 使用自己的 Key

`cds_code_review_submit` 可选 `userKey`，包含 `provider`（`openai` / `anthropic` / `openrouter` / `deepseek`）、`model`、`apiKeyEnv`（本地环境变量名）和 `tokenLimit`（默认 200000）。桥接读取该变量后上传，不在 MCP 参数中填写明文 Key，不把 Key 写入 `.cds/credentials.json`。用户 Key 通道不可用时直接失败，不消费平台额度。`cds_code_review_get` 对用户 Key 任务附带 `usage`；权限不足或通道不可用时标注 `usageUnavailable`。

用量只包含同一项目、同一凭据所有者经本系统产生的请求；不是供应商账号余额。无可靠计价数据时费用为未知。

## DTS 数据同步

DTS 与代码审查复用项目凭据与请求传输层，使用独立工具目录，启动参数为 `--dts`：

```json
{
  "mcpServers": {
    "cds-dts": {
      "command": "node",
      "args": ["/absolute/path/to/prd_agent/cds/mcp/src/server.mjs", "--dts"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

先在项目中运行 `cdscli connect`。工具支持查看连接、比较、幂等启动、查询、暂停、取消、续传和账号规则。
数据库连接与传输服务账号由管理员在 CDS 项目配置中登记；MCP 不接收调用方传入的 host、项目或数据库密码覆盖。
版本不兼容或能力目录失效会阻止写操作。任务必须通过 CDS 独立对账才显示完成；超时继续查询原编号。

## 工程规划

工程规划复用当前项目的 CDS 凭据，使用独立的 `--planning` 模式。

```json
{
  "mcpServers": {
    "cds-planning": {
      "command": "node",
      "args": ["/absolute/path/to/prd_agent/cds/mcp/src/server.mjs", "--planning"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

先在项目中运行 `cdscli connect`。工具按项目返回的能力显示，可读取工程规划、提交待确认提案，或在用户明确授权后直接登记债务。MCP 的回执是当前操作依据，提案确认由有权限的成员在 CDS 中完成。写入没有回执时复用原请求编号和内容。

计划提案可在 `draft.debtIds` 提交已核对的本项目未偿债务编号。成员确认后同时创建计划和关联步骤。

## 私有设计

将启动参数设为 `--design` 并从已绑定的 CDS 项目工作区启动。请由系统所有者为智能体签发项目内 `designAccess: "read"` 或 `designAccess: "publish"` 的专用凭据。把已授权的主机、项目和凭据注入当前执行环境，用 `cdscli init --yes` 建立本地绑定。

| 工具 | 输入 | 行为 |
|---|---|---|
| `cds_design_read` | `view` 取 `designs`、`frameworks`、`design` 或 `framework`。读取单项时填写 `id`，可选 `version` | 列出稿件和框架，或读取选定版本。 |
| `cds_design_publish` | `zipPath`、`sourceCommit`、`sourcePath`、`requestId`。更新时填写原 `designId`，可选 `note` | 由 CDS 核对该项目 Git 提交和文件后，发布私有版本。同一稿件沿用同一发布者。 |

项目内 ZIP 须从已同步的 Git 提交导出，最大 4 MiB。源目录包含稿件清单、思路和原型。发布后用项目内同稿编号读取新旧版本。对比实拍可用 `cdscli design diff` 或 CDS 设计页。
