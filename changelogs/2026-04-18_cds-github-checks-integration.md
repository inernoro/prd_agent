| feat | cds | GitHub App webhook 接入：POST /api/github/webhook 接收 push 事件，自动创建/刷新 CDS 分支并触发部署，Railway 式 Check Run 回写到 PR Checks 面板（点击"Details"直达 CDS 预览分支） |
| feat | cds | Project 新增 githubRepoFullName/githubInstallationId/githubAutoDeploy 三元组，支持 POST/DELETE /api/projects/:id/github/link 将项目绑定到 GitHub 仓库 |
| feat | cds | GitHubAppClient 服务：零新依赖（Node 原生 crypto RS256 JWT + HMAC-SHA256 webhook 签名校验）、安装 token 内存缓存、check runs POST/PATCH、installations/repos 列表 |
| feat | cds | 部署流水线挂接 check-run 生命周期：building 阶段 POST status=in_progress,完成后 PATCH conclusion=success/failure 并把 `<分支>.<domain>` 预览 URL 嵌入 summary |
| feat | cds | GET /api/github/app / GET /api/github/installations / GET /api/github/installations/:id/repos 三个辅助端点,给 UI 用于引导操作员安装 App + 挑选仓库绑定 |
| feat | cds | 新增配置项 githubApp {appId, privateKey, webhookSecret, appSlug} + publicBaseUrl,env 优先（CDS_GITHUB_APP_ID/_PRIVATE_KEY/_WEBHOOK_SECRET/_APP_SLUG, CDS_PUBLIC_BASE_URL）,兼容 `.cds.env` 里 `\\n` 字面值的 PEM |
