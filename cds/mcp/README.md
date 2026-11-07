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
| `cds_code_review_submit` | `zipPath` 或 `githubUrl`；可选 `ref`、`excludePatterns`、`title`、`email`、`idempotencyKey` | 创建异步审查任务；显式提供邮箱才额外发信 |
| `cds_code_review_get` | `taskId` | 查询进度、失败原因、报告 ID 和投递状态 |
| `cds_code_review_list` | 无 | 查询凭据绑定项目的任务与报告关联 |
| `cds_code_review_report_upload` | `filePath`、`title`；可选 `idempotencyKey` | 上传已有 HTML/Markdown 报告，无需重新审查 |

工具发现读取 CDS `/api/code-reviews/capabilities` 的共享能力目录，只展示服务端登记的工具。
工具调用同样校验该目录；服务端未开放的工具不能调用。缺少目录、格式错误或版本不兼容时明确失败，
不会将本地工具定义当作后端已经支持的证据。客户端再次发现工具时刷新目录并撤销失效能力。

上传路径必须位于当前项目内，拒绝指向工作区外的软链接及 `.cds`、`.git` 目录。
ZIP 最大 100 MiB，报告最大 10 MiB。文件只在本机读取，以 multipart 字节上传；服务器不读取客户端路径。
所有报告默认受 CDS 项目权限保护，不开启匿名分享。通过任务返回的报告 ID 打开 CDS 报告阅读器。

HTTPS 为默认要求，只有回环地址允许 HTTP。网络请求沿用 HTTP(S)_PROXY、NO_PROXY 和 Node CA 信任；
不会跟随重定向传送项目凭据。错误中不返回凭据原文。

运行真实 stdio 客户端集成测试与语法检查：

```bash
pnpm --dir cds/mcp test
pnpm --dir cds/mcp check
```
