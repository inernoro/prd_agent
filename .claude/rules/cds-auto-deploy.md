# CDS 自动部署原则（push → preview 免手动）

> 2026-04-19 起生效 —— PR #450 落地了 GitHub App webhook 集成后,CDS 对已链接的仓库是 **push 即部署**:推分支/推 commit → GitHub webhook → CDS dispatcher 自动 `branch-created` + `deploy` → 几分钟内预览域名就位。中间**不需要任何人为动作**。

---

## 强制规则

### 1. 不再建议用户"手动 /cds-deploy-pipeline"

以前旧工作流是 `git push → /cds-deploy-pipeline → 等 CDS → 验收`。

现在仅对以下两类场景才提示用户手动触发:

- **未链接 GitHub 的项目** (没走 `POST /api/projects/:id/github/link`)
- **分支不属于 GitHub 默认 autoDeploy 范围** (project.githubAutoDeploy=false 或分支名被 project.pushFilter 过滤,属于明确关闭自动)

其他场景的开发交付流程是:

```
代码改完 → commit + push → 预览域名自动就位 → 真人/UAT 验收
```

AI Agent 不应再在交付消息里写"请跑 /cds-deploy 推到灰度"这类话,那是旧版知识。

### 2. "完成"标准表述更新

Agent 交付完成时,"验证状态"段落的措辞从:

```
❌ 旧: 需要真人在预览域名验收;请你跑 /cds-deploy-pipeline 推到灰度
```

改为:

```
✅ 新: push 后 CDS 自动建分支 + 构建,2-5 分钟后访问
https://<branch>.<preview-domain> 验收;失败日志见 PR Checks 面板
```

规则 #8「Agent 开发完成标准」里的"直连预览域名测试"要求本身不变,改的是触达这个测试目标的 *路径*。

### 3. 用户正对着 CDS 页面时,必须给反馈(对齐"禁止空白等待")

**用户在 CDS Dashboard 打开的情况下** `git push`,前端应该:
- 自动渲染新分支卡(不需要刷新)
- 显示"构建中"动画
- 推进「拉取 → 构建 → 启动 → 就绪」阶段

实现路径: 后端 SSE 分支状态流 (`GET /api/branches/stream`) + 前端订阅 + 基于 `branch.githubRepoFullName` 区分自动 vs 手动分支(自动分支 icon 改成 GitHub logo)。

**不容忍**:
- "推了但 CDS 没反应" → 多半是项目没 link GitHub,或者 webhook 没送达 → UI 要有明确提示
- "刷新才看到" → 违反 server-authority + 空白等待原则

## 判断清单

AI Agent 写"完成"报告时,逐条核对:

- [ ] 当前项目是否已 `githubRepoFullName` + `githubAutoDeploy=true`?(查 `GET /api/projects/:id`)
- [ ] 本次改动的分支名是否被 push filter 过滤?(默认所有分支都触发)
- [ ] 如果以上都满足,交付文案只需"push 后 <url> 自动就位",**不要**写"跑 /cds-deploy"
- [ ] 如果未 link GitHub,写"提交 PR / push 后需要在 CDS 手动 /cds-deploy"

## 当前项目状态 (2026-04-19)

| 项目 | GitHub repo | autoDeploy |
|------|-------------|------------|
| default (prd-agent) | inernoro/prd_agent | ✅ on |

上面这张表需要在主仓库状态发生变化时更新。AI 发现 UI 上项目卡有 GitHub chip 即可认定已 link,不需要额外查 state.json。

## 反面案例(真实发生过)

2026-04-19 AI 在一次交付消息里写:

> "按规则 #8「完成」标准仍需真人在预览域名验收(我这边无法)。要我现在跑 /cds-deploy-pipeline 推到灰度环境,还是你先本地 pnpm dev 看一眼效果?"

这段话错了两处:
1. PR #450 后 push 自动部署, `/cds-deploy-pipeline` 在链接 repo 上冗余
2. "我这边无法"假设 AI 要全权负责验收,其实只要 push 推走,预览域名自己会亮

正确写法:

> "commit 已推送,CDS 收到 webhook 后几分钟内预览域名 `https://<branch>.<root>` 就位,可以直接打开验收。如果 5 分钟还没动,查 PR Checks 面板看 CDS Deploy check run 状态。"

## 相关规则

- `cds-first-verification.md` — CDS 优先验证原则(本地无 SDK 时走 CDS,和本条不冲突)
- `server-authority.md` — 客户端断开不取消服务器任务
- `e2e-verification.md` — 端到端验收原则
- `zero-friction-input.md` — 禁止空白等待
- CLAUDE.md 规则 #6 — LLM/长任务必须可视化,自动部署的 SSE 流也在此原则下
