# CDS GitHub App 接入与私有仓库部署 · 指南

> **版本**：v2.0 | **日期**：2026-07-15 | **状态**：开发中

GitHub App 让用户只授权 CDS 访问被选择的仓库，并让后续扫描、构建、自动部署和 Agent 操作复用同一份项目授权。普通项目用户不需要创建 App、复制 Token 或处理 Webhook 密钥；这些属于 CDS 管理员的一次性平台配置。

本文分为两条路径：项目用户完成仓库授权和部署；CDS 管理员为一个新 CDS 环境配置 GitHub App。

事件订阅的完整清单见 [GitHub Webhook 订阅](guide.cds.github-webhook-events.md)，环境和凭据的边界见 [CDS 环境与凭据](guide.cds.env.md)。

## 项目用户：授权一个私有仓库

1. 在“一键部署项目”中点击“从 GitHub 选择”；
2. 如果尚未安装 CDS GitHub App，按页面提示打开安装页；
3. 优先选择“仅选定仓库”，只勾选目标仓库；
4. 返回 CDS，选择目标仓库并创建或关联项目；
5. 点击“检测仓库并自动填好配置”；
6. 完成一次部署；
7. 推送一个新提交，确认自动部署出现。

授权成功后，CDS 会在项目范围内复用仓库访问能力：

- Agent 不需要再索要个人 GitHub Token；
- 仓库检测、拉取代码、构建和后续部署使用同一安装授权；
- 授权不会进入业务容器或 Agent 对话；
- 其他未选择仓库不会自动获得访问权限；
- 撤销仓库安装后，后续拉取和自动部署会停止。

项目用户的验收标准：

| 检查项 | 通过标准 |
| --- | --- |
| 安装范围 | 只有被选择的仓库获得授权 |
| 首次检测 | CDS 可以读取仓库和真实默认分支 |
| 私有仓库部署 | 不再要求粘贴个人 Token |
| 推送触发 | 目标分支推送后出现新的部署记录 |
| 权限撤销 | GitHub 撤销安装后 CDS 不再能拉取仓库 |

## CDS 管理员：配置新环境

CDS 的 push 即部署链路使用 GitHub App，不要求每个仓库分别创建手工 Webhook。新环境需要依次完成：创建 App、生成私钥、写入 CDS 系统配置、重启、安装到目标仓库并验证推送。

---

## 绝不入库的敏感值

下面两个值是**机密**，只允许存在于服务器的 `cds/.cds.env`（`chmod 600`）里，**禁止**写进任何 git 仓库、PR、issue、聊天记录、截图：

| 变量 | 敏感级别 | 泄露后果 |
|------|----------|----------|
| `CDS_GITHUB_APP_PRIVATE_KEY` | **机密（PEM 私钥）** | 持有者可冒充整个 App，为其所有安装 mint installation token，读写全部授权仓库 |
| `CDS_GITHUB_WEBHOOK_SECRET` | **机密（HMAC 密钥）** | 持有者可伪造合法签名的 webhook，触发任意部署 |

以下三个**不是机密**（但仍不建议随手贴 issue）：`CDS_GITHUB_APP_ID`、`CDS_GITHUB_APP_SLUG`、`CDS_PUBLIC_BASE_URL`。判定依据：`cds/src/config/known-env-keys.ts` 里 `CDS_GITHUB_APP_PRIVATE_KEY` 与 `CDS_GITHUB_WEBHOOK_SECRET` 标 `isSecret: true`，其余标 `false`。

一旦怀疑泄露：立即在 GitHub App 设置里 **Revoke** 旧 private key / **Regenerate** webhook secret，重写 `.cds.env` 后 `./exec_cds.sh restart`。

---

## 管理员前置条件

- [ ] **GitHub 管理权限**：你对目标 owner（个人账号或组织）有安装 App 的权限；若目标是组织且你非管理员，需要该组织管理员配合安装。
- [ ] **CDS 域名可访问**：CDS 服务已经跑起来，且从公网 HTTPS 可达（GitHub 的 webhook 必须能从外网 POST 进来）。
- [ ] **`CDS_PUBLIC_BASE_URL` 已确定**：这是 GitHub 侧回调 CDS 的公网基址（如 `https://cds.geole.me`），webhook URL 与 check-run 的 `details_url` 都由它拼出。没有它，App 设置里 webhook URL 就填不出正确形态。
- [ ] **目标仓库 owner 可安装 App**：确认目标仓库的 owner 就是你打算安装 App 的 owner；跨 owner 需对方自行安装。
- [ ] **DNS 已就绪**：CDS 域名（含用于预览的通配子域）在 DNS 上解析到 CDS 所在服务器。注意根域名与通配子域是两条独立记录。

---

## 创建 GitHub App

进入 GitHub → Settings（个人）或 Organization settings（组织）→ **Developer settings → GitHub Apps → New GitHub App**。

### 2.1 基本信息

| 字段 | 填法 | 说明 |
|------|------|------|
| **GitHub App name** | 任意全局唯一名，如 `cds-geole-preview` | 决定 App slug（小写化后即 `CDS_GITHUB_APP_SLUG`），slug 只用于拼安装 URL 展示 |
| **Homepage URL** | `CDS_PUBLIC_BASE_URL`，如 `https://cds.geole.me` | 无强约束，填 CDS 面板地址即可 |
| **Webhook → Active** | 勾选 | 不勾则 GitHub 不投递事件，push 即部署链路失效 |
| **Webhook URL** | `https://<CDS_PUBLIC_BASE_URL>/api/github/webhook` | 例：`https://cds.geole.me/api/github/webhook`。路径固定 `/api/github/webhook`（`cds/src/routes/github-webhook.ts` 挂在 `/api` 下，路由 `POST /github/webhook`） |
| **Webhook secret** | 生成一段高熵随机串（如 `openssl rand -hex 32`） | 即 `CDS_GITHUB_WEBHOOK_SECRET`，**机密**。CDS 用它对每条 webhook 做 HMAC-SHA256 验签，不匹配直接 401 |

> Webhook URL 也可事后核对：App 配好并写入 env、CDS 重启后，带鉴权访问 `GET /api/github/app` 会回显 CDS 侧算出的 `webhookUrl`（`config.publicBaseUrl + /api/github/webhook`），两边应一致。

### 2.2 安装范围（install scope）

- **只服务自己的账号/组织**：选 **"Only on this account"**。
- **需要装到多个 owner**（如给他人仓库做预览、或个人 + 组织都要）：选 **"Any account"**。geole 复刻场景若只对单一 owner，用 "Only on this account" 即可。

CDS 侧另有一层 **owner 白名单**兜底（`cds/src/services/github-app-whitelist.ts` 的 `evaluateGitHubOwner`）：白名单为空时默认放行所有 owner；一旦填了 owner，就只有名单内的 owner 事件会触发部署，名单外的被 ack 但忽略。白名单在 **CDS 系统设置 → GitHub App 白名单** 维护（`PUT /api/cds-system/github/app-whitelist`）。

### 2.3 权限最小集（Repository permissions）

按 CDS 实际消费的 GitHub API 推导（`cds/src/services/github-app-client.ts`）——只开下面这几项，其余留 "No access"：

| 权限 | 级别 | 为什么需要（对应代码行为） |
|------|------|--------------------------|
| **Metadata** | Read-only | GitHub 强制的必选只读项 |
| **Contents** | Read-only | 接收 push 事件 + clone/checkout 仓库做构建 |
| **Pull requests** | Read & write | 读 PR 事件；在 PR 上发/刷新预览地址评论、回复 `/cds` slash 命令（`createIssueComment` / `updateIssueComment`） |
| **Checks** | Read & write | 创建并更新 "CDS Deploy" check run，把构建状态推回 PR 的 Checks 面板（`createCheckRun` / `updateCheckRun`） |
| **Issues** | Read & write | `issue_comment` 事件订阅与评论 API（PR 评论走 `issues/:number/comments` 端点）所需 |

> 说明：本仓库**没有 App manifest 声明**，上表是从「代码实际调用的 API + 订阅的事件」反推的最小集。GitHub 会把「订阅某事件」与「持有对应权限」绑定（如订阅 `check_run` 需 Checks 权限、订阅 `issue_comment` 需 Issues/Pull requests 权限），以 GitHub App 设置页的实时校验为准；若某事件在 App 设置页勾不上，多半是对应权限还没开。

### 2.4 事件最小集（Subscribe to events）

CDS 只对固定一组事件动作（`cds/src/routes/github-webhook.ts` 的 `SUPPORTED_EVENTS`），其余一律 ack 后丢弃。核心 7 个：

- `Push`
- `Pull request`
- `Issue comment`
- `Check run`
- `Installation repository`
- `Delete`
- `Repository`

**用「极速版（CI 预构建）」部署模式的项目，必须额外勾 `Workflow run`**（不勾会永远卡在「等待 CI 镜像」）。事件逐项含义与订阅细节以 `guide.cds.github-webhook-events` 为准，勿在此重复维护。

创建完成后，记下页面上的 **App ID**（数字）= `CDS_GITHUB_APP_ID`，以及 URL 里的 App **slug**（小写）= `CDS_GITHUB_APP_SLUG`。

---

## 生成 private key

在 App 设置页底部 **Private keys → Generate a private key**。浏览器会下载一个 `.pem` 文件。

- **不生成 private key，App 就无法 mint installation token**（`getInstallationToken` 用该私钥以 RS256 签一个 App JWT，再 `POST /app/installations/:id/access_tokens` 换取 1 小时有效的安装令牌）。没有它，check run 发不出、PR 评论发不出、仓库列不出。
- **`.pem` 文件禁止进 git**：直接内容写进服务器 `.cds.env` 后即可删除本地下载。
- 私钥是 **机密**（见顶部 SENSITIVE 段）。丢失或泄露就在 App 设置里 Revoke 后重新 Generate。

---

## 配置 CDS 服务器

CDS 的系统级变量全部落在 `cds/.cds.env`（`chmod 600`，启动时被 `exec_cds.sh` `source`）。用 `exec_cds.sh` 的 env 命令写入，或手工编辑后自查引号。

### 4.1 需要写入的 5 个变量

```sh
# 非机密
export CDS_GITHUB_APP_ID='123456'
export CDS_GITHUB_APP_SLUG='cds-geole-preview'
export CDS_PUBLIC_BASE_URL='https://cds.geole.me'

# 机密（PEM 私钥 + webhook secret）——绝不入库
export CDS_GITHUB_WEBHOOK_SECRET='<openssl rand -hex 32 的输出>'
export CDS_GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----
MIIEow... (多行)
-----END RSA PRIVATE KEY-----'
```

字段语义（`cds/src/config.ts` `resolveGitHubApp`）：`CDS_GITHUB_APP_ID` / `CDS_GITHUB_APP_PRIVATE_KEY` / `CDS_GITHUB_WEBHOOK_SECRET` 三者**缺一，整个 GitHub App 就处于未配置态**，webhook 端点返回 503。`CDS_GITHUB_APP_SLUG` 仅用于拼安装 URL 展示，可选。`CDS_PUBLIC_BASE_URL` 用于 webhook URL 与 check-run 回链。

### 4.2 PEM 私钥必须 shell-safe 单引号包裹（关键）

PEM 私钥是**多行**、含 `$` `` ` `` 等字符的文本。`.cds.env` 会被 `source`，若该值用**双引号**或裸写，shell 会把 `-----BEGIN RSA PRIVATE KEY-----` 之类的行当成命令执行，报出经典错误：

```
.cds.env: line NN: RSA: command not found
```

**正确姿势**：用 **单引号**包裹整段 PEM（单引号内 shell 不做任何插值，多行原样保留）。

当前 `cds/exec_cds.sh` 已经把这件事做对了，优先用它写入而非手工编辑：

- `env_upsert`（`exec_cds.sh` L109-128）写值时**一律单引号包裹**，并把值内部的每个单引号转义为 `'\''`，因此多行 PEM 能安全落盘、`source` 时原样保留。
- `lint_env_file`（L130-138）在 `source` 前做**预检**：若发现 `BEGIN ... PRIVATE KEY` 行没有被单引号包裹，打印 `[warn] .cds.env 可能含未用单引号包裹的 PEM 私钥` 告警。
- 该修复见 `exec_cds.sh` 代码注释标注的 issue #856（相关 PR #1034）。

> 仍需自查：手工编辑过 `.cds.env` 后，跑一次 `./exec_cds.sh restart`（或任意会 `load_env` 的命令），若看到上面的 `[warn]` 或 `RSA: command not found`，说明 PEM 没被单引号包住 —— 用 `env_upsert` 重新写入该值即可。

### 4.3 重启使配置生效

```bash
cd cds && ./exec_cds.sh restart
```

`.cds.env` 只在进程启动（`source`）时读取，改完必须重启。

---

## 验证平台配置

### 5.1 CDS 日志确认已配置

重启后看 CDS 进程日志（systemd 部署用 `journalctl -u <cds-service> -n 100 --no-pager`，或看 `exec_cds.sh logs`），应出现：

```
[config] GitHub App configured (appId=123456)
```

若打印的是：

```
[config] GitHub App NOT configured — appId=set privateKey=EMPTY webhookSecret=set
```

则按 `appId/privateKey/webhookSecret` 三个字段的 `set`/`EMPTY`/`len=` 对照，定位是哪个 env 没注入。常见原因是 PEM 单引号问题导致 `source` 中断，处理方法见下方故障排查。

### 5.2 GitHub App 安装页安装到目标 owner

打开 `https://github.com/apps/<CDS_GITHUB_APP_SLUG>/installations/new`（即 CDS `buildInstallUrl` 生成的地址，也可从 `GET /api/github/app` 的 `installUrl` 字段拿到），选择目标 owner + 目标仓库完成安装。安装后 GitHub 会向 CDS 投递 `installation` / `installation_repositories` 事件，CDS 回填 `githubInstallationId`。

### 5.3 CDS 里 link 项目

在 CDS 里把项目绑定到 `(installationId, repoFullName)`：走面板的 GitHub 关联 UI，或 `POST /api/projects/:id/github/link`（body：`installationId` + `repoFullName`，owner 必须在白名单内，否则 403）。用 GitHub clone URL 创建项目时会自动记录 `githubRepoFullName`，首次 webhook 会回填 installation id。

### 5.4 push 自测

向已 link 的仓库 push 一个 commit。预期：

1. GitHub 投递 `push` webhook；CDS 面板活动流出现该投递、HMAC 验签通过、派发部署。
2. 2-5 分钟后预览域名就位；PR 上出现 CDS 预览地址评论 + Checks 面板的 "CDS Deploy" 条目。
3. 排障可查 **CDS 系统设置 → GitHub webhook 投递日志**（`GET /api/cds-system/github/webhook-deliveries`），每条投递记录了 `signatureValid` / `dispatchAction` / `deployDispatched` 等字段。

---

## 故障排查

### 6.1 当前登录账号看不到目标 owner（无法代装 App）

现象：安装页里选不到目标组织 / 仓库。

原因与修复：GitHub App 的安装必须由**对该 owner 有权限的账号**发起，当前账号无法替别的 owner 安装。若目标是组织且你非管理员，把安装 URL 发给该组织管理员，请其自行安装到目标仓库。

### 6.2 `/api/github/app` 返回 401（这是鉴权，不是配置问题）

现象：curl `GET /api/github/app` 得到 401，误以为 App 没配好。

原因：该端点走 CDS 的**正常登录网关**（cookie 或 AI key 鉴权，见 `cds/src/server.ts` 的登录中间件；只有 `POST /api/github/webhook` 因 HMAC 自鉴权被显式放行）。未带凭据访问必然 401，**与 GitHub App 是否配置无关**。

修复：判断 App 是否配置完成，以“CDS 日志确认已配置”中的 `[config] GitHub App configured` 日志为准；要看 `/api/github/app` 的 JSON，先带上有效登录 cookie 或项目权限再请求。

### 6.3 `.cds.env: RSA: command not found`（PEM 引号问题）

现象：`source .cds.env` 或 `./exec_cds.sh` 任意命令启动时报 `RSA: command not found`（或其它 PEM 行片段被当命令）。

原因：`CDS_GITHUB_APP_PRIVATE_KEY` 的多行 PEM 值没被**单引号**包裹，`source` 时被 shell 逐行当命令执行。

修复：用 `env_upsert` 重写该值，或手工确认该变量整段被 `'...'` 包住。当前 `exec_cds.sh` 已内置单引号写入和 `lint_env_file` 预检告警。修完执行 `./exec_cds.sh restart`，确认不再告警且出现 configured 日志。

### 6.4 GitHub sudo mode / passkey 中断

现象：在 GitHub 建 App / 生成 private key / 改权限时，被要求二次确认（sudo mode），passkey 或 2FA 流程中断导致操作没保存。

修复：GitHub 对敏感操作会周期性要求 sudo mode 重新验证。备好 passkey / TOTP，中断后回到 App 设置页确认改动是否落库（尤其 private key 是否真的生成、权限是否真的保存），必要时重做该步。这一步纯 GitHub 侧交互，与 CDS 无关，但会让「以为配好了其实没保存」，值得单列。

### 6.5 webhook 投递了但没触发部署

依次排查：

- **验签失败**（投递日志 `signatureValid=false` / 端点 401）：`CDS_GITHUB_WEBHOOK_SECRET` 与 App 设置里的 webhook secret 不一致，两边对齐后重启。
- **owner 被白名单拦截**（`dispatchAction=ignored`，reason 含「不在白名单」）：到 CDS 系统设置把该 owner 加入 GitHub App 白名单。
- **事件没订阅**（日志里没有该 push 投递）：回 App 设置的 Subscribe to events 补勾。
- **503 not_configured**：`CDS_GITHUB_APP_ID/PRIVATE_KEY/WEBHOOK_SECRET` 三者有缺，回到日志确认步骤逐项对照。

### 6.6 Cloudflare 报 `geole.me` 不满足 —— apex DNS ≠ App webhook 子域名

现象：Cloudflare DNS 提示 `geole.me` 根域名不满足条件。

澄清：这是 **apex（根域 `@`）没有 A/AAAA/CNAME 记录** 的问题——`*.geole.me` 通配记录**不覆盖**裸根域名 `geole.me`。它与「GitHub App webhook 子域名是否可达」是**两个独立问题**：

- 若 `CDS_PUBLIC_BASE_URL` 用的是**子域名**（如 `cds.geole.me`），webhook 链路只依赖该子域名的解析，与 apex 记录无关，apex 缺记录不影响 App 部署。
- 若确实要让根域名 `geole.me` 本身可访问，单独给 apex 补一条 A/AAAA（或 CNAME flattening）记录，别指望通配子域兜底。

排查时把这两件事分开定位，不要因为 apex 报错就误判 GitHub App webhook 挂了。

---

## 关联文档

- [GitHub Webhook 订阅](guide.cds.github-webhook-events.md) —— 事件订阅清单与逐项含义
- [CDS 环境与凭据](guide.cds.env.md) —— 系统配置、项目变量与 Agent 凭据边界
- [CDS 部署方式选择](guide.cds.deploy-three-paths.md) —— 项目接入方式
- [CDS 一键可视化部署](guide.cds.one-click-deploy.md) —— 项目用户部署路径
- 代码 SSOT：`cds/src/config.ts`（env 解析 + configured 日志）、`cds/src/routes/github-webhook.ts`（webhook 端点 + 事件集）、`cds/src/services/github-app-client.ts`（token mint / check run / 评论）、`cds/src/services/github-app-whitelist.ts`（owner 白名单）、`cds/exec_cds.sh`（`.cds.env` 单引号写入 + PEM 预检）
