# CDS GitHub 集成 — 交接给下一个 Agent 的待办清单 · 计划

> **背景**：PR #450 实现了 CDS 的 Railway 风格 GitHub 集成(push 自动部署 + 实时 Check Run 进度 + PR 预览评论 + `/cds` slash 命令 + 删分支停容器 + 注入防御 + orphan check run 回收)。合主干后下一个 Agent 接手继续做剩余工作。
>
> **当前 PR**：https://github.com/inernoro/prd_agent/pull/450 (HEAD: `928dcb90`)
> **功能闭环**：已在生产 cds.miduo.org 线上验证 `/cds help` bot 秒回命令表。
> **代码规模**：29 个 commits、跨 6 轮 Cursor Bugbot 审评(13 条全修)、732 测试全过。

---

## 一、优先级 P0 — 用户明确要求但延后实现

### 1. `default` 项目别名机制(来自用户 #450 反馈)

**现状**：`LEGACY_PROJECT_ID='default'` 硬编码在 `cds/src/routes/projects.ts`、`cds/src/services/worktree.ts`、`cds/src/services/state.ts`、前端 `settings.js`、`projects.js` 几十处。项目 id 是 `default`,展示名字段 `name='prd-agent'`,URL slug 是 `prd-agent`。用户不满意"default"字样在后端到处出现,但直接改 id 需要 state 迁移 + 全栈硬编码清理,风险高。

**用户建议**：加"别名"字段,不改 id,只改显示和匹配。

**下一 Agent 建议方案**：
- `Project` 类型增加 `aliasName?: string` 和 `aliasSlug?: string` 两个字段
- 显示侧全部走 `project.aliasName || project.name`(前端 5 处卡片标题、面包屑、Settings 页 title)
- 分支 id 前缀保持 `project.slug` 不变(已有 branch 继续工作,不迁移)
- 新分支支持可选 `project.aliasSlug` 前缀(UI 切换)
- POST /api/projects/:id/alias 端点
- 文件位置参考:`cds/src/types.ts` Project interface + `cds/src/routes/projects.ts` PUT handler

**不要做**：直接改 `LEGACY_PROJECT_ID`、直接改 `project.id`、直接改 `project.slug`。三者任何一个改动会让所有已有分支 id 无法匹配。

**交付标志**:
- Settings 页可以给项目取别名,别名显示在所有项目卡和分支页标题
- 别名不能影响 GitHub webhook 路由(webhook 仍然按 `githubRepoFullName` 匹配)

---

## 二、优先级 P1 — UX 打磨

### 2. 端口 chips 用项目语言图标替代"api/admin"文字(用户 #450 反馈)

**现状**：端口徽章是 `api:10105`、`admin:10104`,profile id 作文本。
**用户希望**：用项目语言 / 框架图标替换 `api` / `admin` 文字 → `<Node icon> 10105`、`<React icon> 10104`。

**实现要点**:
- 项目卡顶部已有 service strip(N / node / mongo / React 四个大图标) — 复用同一套图标映射
- `cds/web/app.js` 的 `getPortIcon(pid, profile)` 已存在,返回一个 icon,但当前 `portBadgesInner` 也显示 `${pid}:${svc.hostPort}`
- 直接去掉 `pid` 文本,只保留 icon + port。tooltip 保留 profile 名称以备查
- profile 可能没有语言标签,需要给 `getPortIcon` 增加从 stack-detector 推断的逻辑

**测试点**：单项目多 profile(api + admin + desktop)展示正常、未知 profile 有 fallback 通用图标。

---

## 三、优先级 P2 — 完善测试覆盖

### 3. End-to-end 场景测试 (以下流程都只做了单元测试,**没做 E2E 真实触发验证**):

| 流程 | 单元测试 | 线上验证过? |
|------|---------|-----------|
| push → 自动部署 | ✅ | ✅ 多次 |
| PR 开 → bot 评论 | ✅ dispatcher | ❌ 尚未有新 PR 触发过 `opened` 事件 |
| PR 合并 → 自动停预览 | ✅ dispatcher | ❌ 需要关闭 PR #450 验 |
| `/cds help` | ✅ | ✅ 用户实测通过 |
| `/cds redeploy` | ✅ 只测了路径 | ❌ 未实际触发过重部署 |
| `/cds stop` | ✅ 只测了路径 | ❌ 未实际停过容器 |
| `/cds logs` | ✅ 只测了路径 | ❌ 未实际回过日志 |
| "Re-run" check run 按钮 | ✅ check_run.rerequested | ❌ 未点击过 |
| GitHub 删分支 → CDS 自动停 | ✅ delete event | ❌ 未删过远端分支 |
| repo 重命名 → 自动解绑 | ✅ repository event | ❌ 罕见场景 |
| release tag 事件 | ✅ 只 ack | ❌ 占位实现 |
| 注入攻击拒绝 `rm -rf /` | ✅ self-test | ✅ 已测 |
| XSS `owner/x'+alert(1)+'` | ✅ backend regex | ✅ 已测 |

**下一 Agent 可以做**:
- 在 PR #450 合并后开一个新 PR,用来跑一整圈 slash 命令 + 关 PR 验证流程
- 或者等自然积累:下一个自然提交触发 PR 时自动过 Bot 评论、合 PR 时自动验 stop

### 4. `cds/tests/routes/github-webhook.test.ts` 覆盖加强

**现状**: 覆盖了 ping / push / link endpoint,但 `/cds` slash command 路径、PR opened、delete、repository 事件的路由层端到端(从 HMAC-signed POST 到 sideEffect)都没测。dispatcher 已覆盖,但路由层+dispatcher 合起来的黑盒行为没有。

---

## 四、优先级 P3 — 未实装的 Phase 4 功能

这些 App 权限和事件订阅已经开了钩子,代码只占位,可以逐个补实现:

### 5. Release 事件触发生产级部署
**钩子**: `handleRelease` 目前只 `action: 'release-acknowledged'` ack。
**期望**: `release.published` 或 `release.released` → 在 CDS 创建一个特殊的"生产"分支(tag 名作 branchId),用专门的 build profile(`mode: 'production'`)部署,preview URL 可以是 `vX.Y.Z.miduo.org`。

### 6. Workflow run CI-gate
**钩子**: App 已订阅 `Workflow run` 事件(如果用户勾了),dispatcher 尚未实现 handler。
**期望**:
- 订阅 `workflow_run.completed`
- 在 deploy 之前查 GitHub Actions 状态,绿灯后才触发 CDS 部署
- Project 设置面板加"启用 CI gate"开关

### 7. GitHub Deployments API 双向同步
**钩子**: 用户已加 `Deployments: Read & write` 权限(或建议加)
**期望**:
- CDS 部署时 `POST /repos/:o/:r/deployments`,GitHub 的 Code tab 会显示 "Environments" 区块
- 部署状态变化 `POST /repos/:o/:r/deployments/:id/statuses`
- deployment_status 事件如果外部系统写入,触发 CDS 相应动作

### 8. Draft PR 跳过自动部署
**现状**: PR opened (含 draft) 都会贴 bot 评论。
**期望**: 用户可配置,draft PR 不部署,转正后才部署。

### 9. 项目级"push base 限定"开关
**现状**: 任意分支 push 都自动部署。
**期望**: Project 配置"只对匹配正则的分支自动部署",如 `^(main|develop|feature/.+)$`。

---

## 五、P4 技术债清理

### 10. `LEGACY_PROJECT_ID='default'` 全栈清理
参见 **#1 别名机制**。完全正名是另一条路径,不推荐。

### 11. 单仓库绑多项目的边界行为
当前 `findProjectByRepoFullName` 返回第一个匹配项。虽然 `POST /github/link` 校验了"已链接则拒绝",但如果运行时状态被直接改,有可能出现多个 project 链同一 repo 的情况。需要启动时做一致性校验(报警或自动去重)。

### 12. Webhook 幂等性
GitHub 有"at-least-once"送达语义,同一 delivery 可能重复。CDS 目前没幂等性 — 同一次 push 短时间内被 GitHub 重送会触发两次 `branch-created` / `deploy dispatch`。修法:记录最近 100 个 `X-GitHub-Delivery` id,重复的直接 ack。

### 13. `/api/github/webhook/self-test` 生产锁
自测端点目前需要认证但任何认证用户都能 dryRun 任意事件。应该:
- 只接受 ping / issue_comment(只读)类型
- 或加 `NODE_ENV=development` 守卫

---

## 六、验收 checklist(交接给用户)

合并 PR #450 之前 / 之后用户可自验:

- [ ] **浏览器打开 cds.miduo.org 项目列表** → `prd-agent` 卡片显示 GitHub chip(蓝色胶囊,仓库名 `prd_agent`)
- [ ] **进入项目 → 分支列表** → 列表页无视觉空洞,每个分支卡片的 chips(github SHA + 端口)在一行
- [ ] **在 PR #450 下评论 `/cds help`** → bot 秒回命令表 ✅(**已验**)
- [ ] **在 PR #450 评论 `/cds redeploy`** → bot @ 你 + 触发新部署 + 看 Checks 面板
- [ ] **随便 push 一个新分支到 inernoro/prd_agent** → cds.miduo.org 自动出现分支 + 开始部署
- [ ] **关闭 PR #450**(draft close 或真合并) → `claude-github-cds-integration-rxv1e` 预览容器自动停
- [ ] **PR Checks 面板点 CDS Deploy 右侧的 "Re-run"** → 触发重部署 + 新 check run

---

## 七、文件索引 — 下一 Agent 速查

核心新增文件(PR #450 引入):
- `cds/src/services/github-app-client.ts` — GitHub App JWT + Check Run API + Issue comment API
- `cds/src/services/github-webhook-dispatcher.ts` — 核心事件分发逻辑(push/PR/issue_comment/delete/repository/release/check_run)
- `cds/src/services/check-run-runner.ts` — Check Run 生命周期(open / progress / finalize / reconcileOrphans)
- `cds/src/routes/github-webhook.ts` — POST /api/github/webhook + /app + /installations + /projects/:id/github/link + /self-test
- `cds/web/settings.js` 中 `renderGithubAppOverview` + `_settingsGithubLinkOpen` modal + `_settingsForceSync`

核心修改文件:
- `cds/src/types.ts` — Project 加 githubRepoFullName/InstallationId/AutoDeploy/LinkedAt,BranchEntry 加 githubRepoFullName/CommitSha/CheckRunId/InstallationId/PrNumber/PreviewCommentId,CdsConfig 加 githubApp/publicBaseUrl
- `cds/src/routes/branches.ts` — deploy 流水线挂 checkRunRunner.ensureOpen/progress/finalize,self-update 改 git reset --hard,新增 /api/self-force-sync
- `cds/src/config.ts` — resolveGitHubApp 从 env 读 CDS_GITHUB_APP_*

Cursor Bugbot 6 轮累计 13 条审评位置: 每轮 commit message 都明确标注了 `Bugbot #450 第 X 轮`,git log 可追。

---

## 八、GitHub App 配置(cds.miduo.org 当前线上)

- App: `ohmycds` (https://github.com/apps/ohmycds)
- App ID: `3425066`
- Installation: `125106827` (inernoro 个人账号,选仓库 `inernoro/prd_agent`)
- Webhook URL: `https://cds.miduo.org/api/github/webhook`
- Permissions: Checks/Issues/Pull requests (Read+write), Contents/Metadata (Read)
- Events subscribed: Push, Pull request, Issue comment, Check run, Check suite, Delete, Repository, Release, Pull request review + 其他用户多勾的不影响

如果要启动 Phase 4(CI-gate)还需加 `Actions: Read` 权限 + `Workflow run` 事件订阅并在 installation 页 Accept。

---

## 九、紧急状况自愈

本 PR 顺手做了一个自愈能力,任何人(包括下一个 Agent)遇到 "push 了代码但 cds.miduo.org 没生效":

1. UI 方式: https://cds.miduo.org/settings.html?project=default → 危险操作 → **强制同步 CDS 源码到 origin** → 输入分支名 → 点确认
2. CLI 方式:
```bash
curl -N -X POST -H "X-AI-Access-Key: shenmemima" -H "Content-Type: application/json" \
  https://cds.miduo.org/api/self-force-sync \
  -d '{"branch":"main"}'
```
3. 或在项目列表页顶部 "🔄 自动更新" modal 里点左下角的"💥 强制同步 (hard-reset)"按钮

这三条路径做的事相同:`git fetch + reset --hard origin/<branch> + 清 dist 缓存 + 重启`。
