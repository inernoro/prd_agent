# CDS GitHub Webhook 订阅配置指南

> **类型**：操作指南 (How-to) | **日期**：2026-04-19 | **版本**：v1.0 | **适用**：CDS GitHub App

---

## 1. 一句话结论

在 GitHub App "Permissions & events → Subscribe to events" 页面,**只勾 7 个事件就够了**:

- `Push`
- `Pull request`
- `Issue comment`
- `Check run`
- `Installation repository`
- `Delete`
- `Repository`

其他全部留空。即使历史配置中勾了全部事件,CDS 从 2026-04-19 起也会在服务端自动静默过滤,不会导致重复构建或活动流刷屏,但**仍建议去 GitHub 后台取消勾选**,节省 GitHub 端投递成本。

---

## 2. 事件订阅总览表

| 事件 (X-GitHub-Event) | 必要性 | CDS 的动作 | 说明 |
|---|---|---|---|
| `push` | ✅ **必订** | 建/刷新分支 worktree + 触发部署 + 更新 check run | 核心触发器。不订,push 即部署就废了 |
| `pull_request` | ✅ **必订** | opened/reopened → 发预览评论;closed → 停预览容器 | 不订,PR 合并/关闭后容器不会自动回收 |
| `issue_comment` | ✅ **必订** | 解析 `/cds <cmd>` 斜杠命令 (redeploy/stop/logs/help) | 不订,PR 评论里的 `/cds redeploy` 等命令全部失效 |
| `check_run` | ✅ **必订** | `rerequested` → 按 check 重跑部署;其他动作仅记录 | 不订,PR Checks 面板的"Re-run" 按钮失效 |
| `installation_repositories` | ✅ **必订** | 仓库从 installation 移除时自动解绑项目 | 不订,用户在 GitHub 后台取消授权后 CDS 仍会处理旧 push |
| `delete` | ✅ **必订** | 远端分支删除 → 停对应 CDS 预览容器 | 不订,删分支不会回收容器,资源持续占用 |
| `repository` | ✅ **必订** | renamed/transferred/deleted → 解绑项目避免错投 | 不订,仓库改名后 CDS 链接成脏数据 |
| `ping` | 🟢 自动 | 响应 pong | GitHub 创建/更新 App 时自动发一次,不用单独订 |
| `installation` | 🟡 可选 | 记录日志,不做任何状态变更 | 订了也无害,GitHub App 生命周期审计用 |
| `release` | 🟡 预留 | 当前仅 ack,未来接生产标签发布 | 订不订都行,目前无功能影响 |

---

## 3. 被 CDS 静默过滤的噪声事件

以下事件即使 GitHub App 订阅了、签名通过了,CDS 路由层也会**立刻 200 ack 并跳过 dispatcher**,不进 Dashboard 活动流,不触发任何动作。属于"订阅了也没后果,但徒增 GitHub 投递成本"。

| 事件 | 为什么过滤 |
|---|---|
| `check_suite` | GitHub 对每个 commit 自动创建,且 CDS 只关心具体 `check_run`,suite 层不需要 |
| `workflow_run` / `workflow_job` | GitHub Actions CI 的事件,CDS 不替用户跑 CI,只关心自己的 check_run |
| `status` | 老式 commit status API,现已被 check_run 取代 |
| `pull_request_review` / `pull_request_review_comment` / `pull_request_review_thread` | 代码 review 活动,CDS 预览只关心 PR 生命周期 (opened/closed) |
| `commit_comment` | 提交页面上的独立评论,CDS 不处理 |
| `star` / `watch` / `fork` / `public` | 社交/社区事件,与部署无关 |
| `label` / `milestone` / `project` / `project_card` / `project_column` / `projects_v2*` | 项目管理类元数据 |
| `discussion` / `discussion_comment` | Discussions 板块,不是代码 |
| `member` / `membership` / `organization` / `org_block` / `team` / `team_add` | 权限/团队变更 |
| `page_build` | GitHub Pages 构建 |
| `deployment` / `deployment_status` | GitHub 原生 Deployments API,CDS 有自己的部署链路 |
| `registry_package` / `package` | GitHub Packages |
| `meta` | webhook 配置被删除时触发一次,CDS 不处理 |
| `secret_scanning_alert*` / `code_scanning_alert` / `dependabot_alert` / `repository_advisory` | 安全告警,与部署无关 |
| 其他未列举事件 | 统一走白名单外分支 |

> **实现位置**:`cds/src/routes/github-webhook.ts` 顶部 `SUPPORTED_EVENTS` 白名单。不在集合内的事件一律走 `ignored-unsubscribed` 分支,响应体 `{ok:true, action:'ignored-unsubscribed'}`,同时设响应头 `X-CDS-Suppress-Activity: 1` 让活动中间件跳过广播。

---

## 4. 如何在 GitHub App 后台配置订阅

### 4.1 打开订阅页

1. 以 App 所有者身份登录 GitHub
2. 打开 https://github.com/settings/apps
3. 选中你的 CDS App → 左侧 **"Permissions & events"**
4. 下拉到 **"Subscribe to events"** 区块

### 4.2 只勾 §2 表中"✅ 必订"的 7 项

页面上 GitHub 的命名和事件名有微小差异,按以下对照勾选:

| 事件名 | GitHub 页面勾选项 |
|---|---|
| `push` | **Push** |
| `pull_request` | **Pull request** |
| `issue_comment` | **Issue comment** |
| `check_run` | **Check run** |
| `installation_repositories` | *(自动启用,不在可勾选列表里)* |
| `delete` | *(自动启用,分支/tag 删除)* |
| `repository` | **Repository** |

`installation_repositories` 和 `delete` 默认就会送,不需要手动勾。

### 4.3 保存

页面底部 **Save changes**。GitHub 会立刻按新订阅集合推送事件,无需重启 CDS。

---

## 5. 如何验证 CDS 真的收到 / 过滤对了

### 5.1 查 GitHub App 的 Recent Deliveries

GitHub App 设置页 → **Advanced → Recent Deliveries** 列出最近 30 次投递。每条显示:

- HTTP 状态码(CDS 侧现在**只会返 200**,即使 dispatcher 抛错也返 200 ok:false)
- Request Headers / Body(GitHub 签名后的原始 payload)
- Response Headers / Body(CDS 响应,里面有 `action` 字段表明走了哪条分支)

若看到 `action: "ignored-unsubscribed"`,说明你 GitHub App 订阅了但 CDS 没处理(属于预期行为)。

### 5.2 用 CDS 自带的自测端点

CDS 提供一个 dry-run 自测端点,**不真的 deploy**,只告诉你某个事件会走哪条分支:

```bash
curl -sS -X POST "$CDS_URL/api/github/webhook/self-test" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "eventName": "push",
    "payload": {
      "ref": "refs/heads/feature-x",
      "after": "deadbeef1234567890abcdef1234567890abcdef",
      "repository": {"full_name": "inernoro/prd_agent"},
      "installation": {"id": 12345}
    }
  }' | python3 -m json.tool
```

返回 `dispatcherResult.action`:
- `"branch-created"` / `"branch-refreshed"` — 会真正触发部署(但在 self-test 里不会真跑)
- `"ignored-no-project"` — repoFullName 没绑定任何项目
- `"ignored-auto-deploy-off"` — 项目 `githubAutoDeploy=false`
- `"ignored-event"` — push 目标不是分支(比如 tag)

### 5.3 看 Dashboard 活动流

推一次代码后,Dashboard 右上角 Activity 面板的条目现在追加了事件类型后缀:

```
POST  GitHub 推送 Webhook · push         200  120ms
POST  GitHub 推送 Webhook · check_run    200   15ms
```

若 GitHub App 仍订阅了噪声事件,它们**不会**出现在这里 —— 被 `X-CDS-Suppress-Activity` 头过滤掉了。想看完整投递明细,去 §5.1 的 GitHub Recent Deliveries 面板。

---

## 6. 常见问题

### Q1: 我只想让 CDS 部署某些分支,不想 push 到 main 就部署

项目详情页 Settings → 把 **Auto-Deploy** 关掉(对应 `githubAutoDeploy=false`),然后在需要部署的分支上用 `/cds redeploy` PR 斜杠命令手动触发。

### Q2: CDS 返 500 了会怎样? GitHub 会重试吗?

2026-04-19 之后 **不会**。dispatcher 抛错统一返 200 `{ok:false, error, message}`,GitHub 收到 200 就不会按 8 小时退避策略重投递,彻底断开"500 → 重试 → 反复构建"的循环。错误细节仍在 CDS 服务端日志(`[webhook] dispatch error event=...`)和 Activity body 里。

### Q3: 同一个 commit 被推两次会部署两次吗?

**不会**。CDS 在路由层对 `(branchId, commitSha)` 做 30 秒去重:同一 SHA 在窗口内的第二次 dispatch 会被 skip 并记日志 `[webhook] skip duplicate deploy dispatch ...`。响应体 `deployDedupSkipped: true` 标记此情形。

需要强制重跑可用 `/cds redeploy` 斜杠命令 —— 它走独立代码路径,不经过去重。

### Q4: 我在 GitHub App 里已经勾了所有事件,懒得改,会不会出问题?

不会。从 2026-04-19 起 CDS 路由层会静默 ack 掉所有非白名单事件,既不触发动作也不污染活动流,和"只订 7 个"的运行效果一致。唯一差别是 GitHub 那边会每次都发网络请求过来,白白消耗带宽。推荐仍按 §2 精简订阅。

### Q5: 新增一种订阅事件需要改哪里?

1. `cds/src/services/github-webhook-dispatcher.ts` 的 `handle()` switch 增加一个 case + `handleXxx()` 私有方法
2. `cds/src/routes/github-webhook.ts` 顶部 `SUPPORTED_EVENTS` 集合加入事件名
3. 本文档 §2 表补一行
4. `cds/tests/services/github-webhook-dispatcher.test.ts` + `cds/tests/routes/github-webhook.test.ts` 加用例
5. `changelogs/` 加一条 `feat | cds | 新增 xxx 事件订阅...` 碎片

---

## 7. 相关文件

- `cds/src/routes/github-webhook.ts` — webhook 路由,白名单 + dedup + 500→200 逻辑
- `cds/src/services/github-webhook-dispatcher.ts` — 事件分发核心
- `cds/tests/routes/github-webhook.test.ts` — 单测(噪声过滤/去重/500→200)
- `.claude/rules/cds-auto-deploy.md` — push 即部署原则
- `doc/design.cds.md` — CDS 总体设计
