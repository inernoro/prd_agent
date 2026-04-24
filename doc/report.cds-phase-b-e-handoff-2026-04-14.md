# CDS Phase B/C/D/E + Hardening 交接 · 报告

> **日期**: 2026-04-14 | **分支**: `claude/phase-a-handoff-76ox4` | **作者**: Claude (会话 76ox4)
>
> 上一棒交接见 `report.cds-phase-a-handoff-2026-04-14.md` (Phase A 由 0NRn1 完成)。
> 本报告覆盖会话 76ox4 在 Phase A 基线上做的全部增量。

---

## 一、执行摘要

| 指标 | 值 |
|------|-----|
| 起点 | Phase A baseline (commit `bd91ae1`, 395 tests pass, 8/8 烟雾验收) |
| 终点 | commit `de9aedb` + 后续 hardening (待 push), **529 tests pass** |
| 新增 commits | 21 个 (Phase B/C/D/E + UX rework + audit + hardening + cleanup) |
| 新增测试 | +134 (395 → 529) |
| 新增端点 | 11 个 (`/api/storage-mode/*`, `/api/github/oauth/*`, `/api/github/repos`, `/api/projects/:id/clone`, `/api/detect-stack`, `/api/self-update-dry-run`) |
| 新增前端页面/Tab | Settings → Storage tab, Settings → GitHub tab, Projects → Smart Input + GitHub Sign-in |
| 新增运维命令 | `./exec_cds.sh install-systemd` |
| 修复 BUG | 12 (P5/P6 placeholder cleanup + Phase E 8-bug audit + ESM require crash + install_deps skip + install-systemd PATH + StartLimitIntervalSec section) |
| 防护新增 | self-update pre-check + dry-run 端点 + module-load 冒烟测试 + systemd ExecStartPre 自愈 |

## 二、用户故事 — 完成了什么

**上一棒留下的核心 P0**: G1 多仓库 git clone — 之前 `Project.gitRepoUrl` 只是装饰字段，没人 clone，CDS 只能管理 bind-mount 的那一个仓库。

**这一棒交付给用户的**: 用户在 `projects.html` 粘一个公开 GitHub URL → 一键创建 → 自动 clone → 自动检测栈 → 自动建 BuildProfile → 部署。零摩擦三路径：

1. **Path A**: 点 "使用 GitHub 登录" → Device Flow → 列私有/公开仓库 → 选一个 → 自动填 URL → 提交 (注入 token 解决私有仓库)
2. **Path B**: 直接粘 URL (公开仓库) → 提交
3. **Path C**: 输入项目名 → 创建空项目 (无 Git 集成)

外加 MongoDB 存储后端 (auto-fallback / 运行时切换 / seed-from-json) 和一整套 self-update 防护 (dry-run + pre-check + module-load smoke + systemd 自愈)。

> **未完成**: P5 (Team workspace + GitHub Org 绑定) 和 P6 (webhook + 自动部署策略) 仍未开始。Phase D 的"系统配置 vs 用户配置 mongo 集合隔离"也只做了单 collection 单文档版本 — 多用户隔离留给 P5。

## 三、commit 时间线 (新→老)

```
de9aedb  cleanup    install-systemd PATH 注入 + 移除所有 P5/P6 dead placeholder
96f04e2  hardening  self-update pre-check + dry-run + module-load smoke + 自动 systemd
1bbabdb  audit      MECE 审查 8 bug 修复 (HIGH 私有仓库 token / 凭据脱敏 / ESC 关错)
c69454a  hotfix     ESM require() crash + install_deps skip-on-new-deps bug
d4f31a1  E.2 + E.3  GitHub Device Flow UI + Settings GitHub tab
1988da4  E.1        GitHub Device Flow backend (5 endpoints + 16 tests)
0b5f663  UX rework  砍掉坏掉的 GitHub explainer + Railway 风格 Smart Input
6b717b4  G10        Stack auto-detect (8 种栈 + 19 tests)
7693671  D.3        Storage-mode router + Settings Storage tab + 8 tests
8de0644  D.2        Mongo backend wire + auto-fallback + seed-from-json
5795393  D.1        MongoStateBackingStore + RealMongoHandle + 12 tests
4e337a9  G1.7       Projects page 克隆 UI (status badge + 进度模态框)
ee6a3c2  G1.6       真 git smoke 测试 (file:// bare repo → clone → worktree)
4107267  G1.5       拒绝 deploy 当 project clone 未 ready (409 守卫)
2a2d46a  G1.4       CDS_REPOS_BASE bind-mount + Dockerfile.master 文档
643f0de  G1.3       POST /api/projects/:id/clone SSE 端点
9383f58  G1.2       stateless WorktreeService (重构 17 个 call sites)
4b3571a  G1.1       Project.repoPath + cloneStatus + getProjectRepoRoot
401a203  G7         Topology Settings tab infra 连接串
6568fab  G6         Topology Details tab Public URL 卡片
eadf5b4  G5         Topology Details tab Deploy/Redeploy 按钮
```

**21 commits，全部已 push 至 `origin/claude/phase-a-handoff-76ox4`。**

## 四、测试基线

| 来源 | 测试数 | 增量 |
|------|-------|------|
| Phase A 起点 | 395 | — |
| G1.1 (state 测试) | 401 | +6 |
| G1.2 (worktree 重构) | 400 | -2 + 1 (concurrent test) |
| G1.3 (clone endpoint) | 408 | +8 |
| G1.5 (deploy guard) | 413 | +5 |
| G1.6 (real-git smoke) | 414 | +1 |
| D.1 (mongo backing store) | 426 | +12 |
| D.3 (storage-mode router) | 434 | +8 |
| G10 (stack detector) | 453 | +19 |
| E.1 (github device flow) | 469 | +16 |
| Audit fixes (URL helpers) | 484 | +15 |
| Hardening (validate + module-load) | 529 | +45 |

最终 **529/529 绿** + TypeScript 编译 clean + bash + JS 语法 clean.

## 五、新增 API 端点 (11 个)

### 多仓库 Clone (Phase B G1)

| Method | Path | 用途 | 实现 |
|--------|------|------|------|
| POST | `/api/projects/:id/clone` | SSE 流式 git clone — start → progress → complete/error | `routes/projects.ts:_runClone` |

> 注：`POST /api/projects` 现在会在 body 含 `gitRepoUrl` 且 `config.reposBase` 已配置时，自动 stamp `repoPath` + `cloneStatus='pending'`，并在响应中返回。前端拿到 pending 状态后会自动调用 `/clone` 端点。

### Storage Mode (Phase D.3)

| Method | Path | 用途 |
|--------|------|------|
| GET    | `/api/storage-mode` | 当前后端 (json/mongo/auto-fallback-json) + 健康状态 + masked URI |
| POST   | `/api/storage-mode/test-mongo` | 预检 mongo URI 连通性 (5s 超时) |
| POST   | `/api/storage-mode/switch-to-mongo` | 运行时切换 json → mongo (含 seed-from-json) |
| POST   | `/api/storage-mode/switch-to-json` | 切回 json (写入 state.json + 关闭 mongo handle) |

### GitHub Device Flow (Phase E.1)

| Method | Path | 用途 |
|--------|------|------|
| POST   | `/api/github/oauth/device-start` | 启动 Device Flow，返回 user_code + verification_uri |
| POST   | `/api/github/oauth/device-poll` | 轮询授权状态 (pending/slow-down/expired/denied/ready) |
| GET    | `/api/github/oauth/status` | 当前连接状态 (configured/connected/login/scopes) |
| DELETE | `/api/github/oauth` | 断开连接 (清除本地 token) |
| GET    | `/api/github/repos` | 列出用户仓库 (前 100，按 updated 排序) |

### Stack Detection (G10)

| Method | Path | 用途 |
|--------|------|------|
| POST   | `/api/detect-stack` | 扫描指定项目/分支/路径，返回 dockerImage + commands + port |

### Self-update Hardening

| Method | Path | 用途 |
|--------|------|------|
| POST   | `/api/self-update-dry-run` | 零副作用预检 (pnpm install + tsc --noEmit) |

> `POST /api/self-update` 也升级了：在 git pull 之后、kill+spawn 之前插入了 `validate` SSE 阶段调用 `validateBuildReadiness()`，失败时不杀进程也不 spawn。

## 六、新增环境变量

| Env | 用途 | 默认 | 必填 |
|-----|------|------|------|
| `CDS_REPOS_BASE` | 多仓库 clone 的目标根目录 (`<base>/<projectId>/`) | `$SCRIPT_DIR/.cds-repos` (exec_cds.sh 默认) | 否 |
| `CDS_STORAGE_MODE` | `json` (默认) / `mongo` / `auto` | `json` | 否 |
| `CDS_MONGO_URI` | Mongo 连接 URI (mode=mongo 必填) | — | mongo 模式必填 |
| `CDS_MONGO_DB` | Mongo 数据库名 | `cds_state_db` | 否 |
| `CDS_GITHUB_CLIENT_ID` | GitHub OAuth App 的 client_id (开 Device Flow) | — | 启用仓库选择器必填 |
| `CDS_GITHUB_CLIENT_SECRET` | (复用 web flow 的 secret，Device Flow 不需要) | — | 否 |

## 七、运维 Runbook

### 7.1 self-update 标准流程 (推荐路径)

```bash
# 1. 在本地 push 代码到目标分支
git push origin <branch>

# 2. 远程 dry-run 预检（不动 CDS 进程）
curl -X POST -H "X-AI-Access-Key:$AI_ACCESS_KEY" \
  https://$CDS_HOST/api/self-update-dry-run

# 期望: { "ok": true, "summary": "pnpm install + tsc --noEmit 通过", "durationMs": ... }
# 若 ok=false: 修代码再 push，不要继续

# 3. 真 self-update
curl -X POST -H "X-AI-Access-Key:$AI_ACCESS_KEY" \
     -H "Content-Type:application/json" \
     -d '{"branch":"<branch>"}' \
     https://$CDS_HOST/api/self-update

# 期望 SSE 流：fetch → checkout → pull → validate → restart → done
# 如果 validate 失败 → 看 SSE error 字段，pre-check 已经救了你

# 4. 等 CDS 重启 (~10s)，验证恢复
for i in $(seq 1 20); do
  curl -sf -H "X-AI-Access-Key:$AI_ACCESS_KEY" "https://$CDS_HOST/api/config" \
    -o /dev/null && break
  sleep 3
done
```

### 7.2 install-systemd 一键安装

```bash
cd cds && ./exec_cds.sh install-systemd
# 输出会告诉你需要复制粘贴的 sudo 命令，类似：
sudo cp /tmp/cds-master.service.XXXXX /etc/systemd/system/cds-master.service
sudo systemctl daemon-reload
sudo systemctl enable --now cds-master
systemctl status cds-master  # 应显示 active (running)
journalctl -u cds-master -f  # 实时日志
```

**生成的 unit 文件包含**：
- `Environment=PATH=<node_bin_dir>:/usr/local/sbin:/usr/local/bin:...` (修复 nvm node 找不到问题)
- `ExecStartPre=pnpm install --frozen-lockfile` (新依赖自愈)
- `ExecStartPre=npx tsc` (编译 stale dist/)
- `Restart=always` + `RestartSec=3s`
- `StartLimitIntervalSec=60` + `StartLimitBurst=5` (在 [Unit] section，符合 modern systemd 规范)
- `MemoryMax=512M` + `CPUQuota=100%` (cgroup v2 限额)

### 7.3 切换到 MongoDB

**前提**：CDS_GITHUB_CLIENT_ID 不必，但要有可达的 mongo (建议起 docker 容器)。

UI 路径：`Settings → Storage → 填 URI → 测试连接 → 切换到 Mongo`。

API 路径：
```bash
# 1. 预检
curl -X POST -H "X-AI-Access-Key:$AI_ACCESS_KEY" \
     -H "Content-Type:application/json" \
     -d '{"uri":"mongodb://admin:pass@host:27017","databaseName":"cds_state_db"}' \
     https://$CDS_HOST/api/storage-mode/test-mongo
# 期望: { "ok": true, "ms": <ping延迟> }

# 2. 切换 (会一次性 seed-from-json)
curl -X POST -H "X-AI-Access-Key:$AI_ACCESS_KEY" \
     -H "Content-Type:application/json" \
     -d '{"uri":"mongodb://admin:pass@host:27017"}' \
     https://$CDS_HOST/api/storage-mode/switch-to-mongo

# 3. 检查
curl -H "X-AI-Access-Key:$AI_ACCESS_KEY" \
     https://$CDS_HOST/api/storage-mode
# 期望: { "mode":"mongo","kind":"mongo","mongoHealthy":true, ... }
```

> **注意**：运行时切换 ≠ 重启后生效。下次进程启动时 `CDS_STORAGE_MODE` env 决定模式。要让 mongo 持久化，需同时把 `CDS_STORAGE_MODE=mongo` + `CDS_MONGO_URI=...` 写到 `.cds.env` (或 systemd EnvironmentFile)。

### 7.4 配置 GitHub Device Flow (启用仓库选择器)

```bash
# 1. 在 https://github.com/settings/developers 创建一个 OAuth App
#    勾选 "Enable Device Flow"
#    拷贝 Client ID

# 2. 写到 cds/.cds.env
echo 'export CDS_GITHUB_CLIENT_ID=Iv1.xxx...' >> cds/.cds.env

# 3. 重启 CDS (走 self-update 或 systemd restart)
./exec_cds.sh restart
# 或
sudo systemctl restart cds-master

# 4. 检查 — Settings → GitHub tab 应该不再显示 "NOT CONFIGURED"
```

完成后用户在 `Settings → GitHub` 点 "Sign in with GitHub" 走 Device Flow，浏览器去 github.com 输入 user_code，回来就能在 New Project 模态框看到 "浏览我的仓库" 按钮。

### 7.5 灾难恢复：CDS 死了 + self-update API 不可达

万一 self-update 把自己搞死了 (不应该，因为有 pre-check，但万一)：

```bash
# 直接在宿主机
cd /path/to/cds
git pull               # 拉最新代码
rm -rf node_modules    # 强制重装依赖
pnpm install
./exec_cds.sh restart  # 重启
tail -50 cds.log       # 看启动日志
```

如果安装了 systemd unit，systemd 的 `Restart=always` 会自动救你。如果还是起不来，看 `journalctl -u cds-master -n 100`。

## 八、已知限制 + 留给下一棒

### 8.1 已知限制（不算 bug，是设计权衡）

| # | 限制 | 影响 | 缓解 |
|---|------|------|------|
| L1 | Mongo 单 collection 单 document — `cds_state.{_id:'state'}` 整存整取 | state 大于 16MB 时 mongo 拒绝 (BSON 限制) | 实际 CDS state 通常 < 1MB；超大客户需要拆 collection |
| L2 | GitHub Device Flow 单租户 — 一个 CDS 实例只存一个 token | 多用户共享 CDS 时谁 sign in 谁的 token 生效 | 等 P5 user model + per-user token store |
| L3 | Repo Picker 只取 100 个 repos | 大 GitHub 账号（>100 仓库）picker 看不全 | 加分页，约 30 行代码，未来 follow-up |
| L4 | Executor 节点不复用 multi-repo clone | 远程 executor 仍用 single repoRoot；不能跨 executor 部署不同仓库 | 真要做需要 P3 改造把 reposBase 同步到 executor |
| L5 | Proxy 自动发现仅查 legacy repoRoot | `feature.cds.miduo.org` 子域名访问只能命中默认仓库的分支；新 clone 出来的项目要显式部署 | 设计权衡，不影响显式部署路径 |
| L6 | 多 tab 并发 Device Flow last-write-wins | 两个 tab 同时跑 Device Flow 会 race state.json | 实际场景罕见，留作 known issue |
| L7 | `Volume / 持久化卷` UI 入口砍掉了 | + Add 菜单不再有该选项 | 卷仍可在 InfraService.volumes 字段配置 |

### 8.2 P5/P6 真的不在范围内（**别再往里塞**）

| 期 | 计划 | 状态 |
|---|------|------|
| P5 | Team workspace + GitHub Org 绑定 + 成员邀请 | ❌ 未开始 |
| P6 | webhook + 自动部署策略 + dirty 标记 | ❌ 未开始 |

P5 是大工程：需要重做 user model（目前 auth-service 用 `MemoryAuthStore` 内存版），加 `workspaces` + `workspace_members` 集合，加 RBAC 中间件，把现有的 Project 模型加 `workspaceId` 字段。建议**单独一个新会话**做。

P6 依赖 P5 完成（webhook 需要 user identity 才能审计）。

### 8.3 follow-up 候选（小工作，可以零散做）

- Repo Picker 加分页（`Link` header 解析）
- `MapAuthStore` (mongo 后端) — 替换 `MemoryAuthStore`，让 GitHub 登录 session 跨重启保持
- detect-stack 加 `nixpacks` 风格的依赖深度推断
- worktreeBase 也 per-project 分目录（避免两个项目都用 `master` 分支时冲突）
- 把 GitHub Device Flow 的 token 用 AES 加密后再写 state.json (目前明文)

## 九、文件索引（给下一棒省 grep 的时间）

### 后端

| 关注点 | 文件 | 关键行 |
|--------|------|------|
| 多仓库数据模型 | `cds/src/types.ts` | `Project.repoPath/cloneStatus`, `CdsConfig.reposBase`, `GitHubDeviceAuth` |
| 项目级仓库根解析 | `cds/src/services/state.ts` | `getProjectRepoRoot()`, `getGithubDeviceAuth()`, `setBackingStore()` |
| 无状态 worktree | `cds/src/services/worktree.ts` | 整文件，全部方法 1st arg = `repoRoot` |
| Clone 路由 + URL helpers | `cds/src/routes/projects.ts` | `_redactUrlUserInfo`, `_injectGithubTokenIfPossible`, `/clone` SSE |
| Storage mode 路由 | `cds/src/routes/storage-mode.ts` | 全文 |
| GitHub OAuth 路由 | `cds/src/routes/github-oauth.ts` | 全文 |
| GitHub OAuth client 扩展 | `cds/src/services/github-oauth-client.ts` | `startDeviceFlow`, `pollDeviceFlow`, `fetchUserRepos` |
| Mongo backing store | `cds/src/infra/state-store/mongo-backing-store.ts` | 全文 (write-behind cache) |
| Mongo 真实 client | `cds/src/infra/state-store/mongo-handle.ts` | `RealMongoHandle` |
| Stack detector | `cds/src/services/stack-detector.ts` | 8 detector functions |
| Self-update 预检 | `cds/src/routes/branches.ts` | `validateBuildReadiness()` line ~20, `/self-update-dry-run` line ~4920 |
| Detect-stack 端点 | `cds/src/routes/branches.ts` | `/detect-stack` line ~5050 |

### 前端

| 关注点 | 文件 | 要点 |
|--------|------|------|
| 创建项目 Smart Input | `cds/web/projects.js` | `_parseSmartInput`, `_updateCreateHint`, `handleCreateProjectSubmit` |
| 克隆进度模态框 | `cds/web/projects.js` | `handleCloneProject`, `_runPostCloneChain` (clone → detect → profile) |
| GitHub Device Flow UI | `cds/web/projects.js` | `_openGithubSignin`, `_pollGithubDevice`, `_openRepoPicker`, `_pickRepo` |
| Stack detect button | `cds/web/app.js` | `_autoDetectStack` 函数（profile form 的 🔍 Auto-detect 按钮）|
| Topology Deploy/URL/连接串 | `cds/web/app.js` | `_topologyRenderPanelTab` (G5/G6/G7) |
| Settings Storage tab | `cds/web/settings.js` | `renderStorageTab`, `_storageTest`, `_storageSwitchToMongo` |
| Settings GitHub tab | `cds/web/settings.js` | `renderGithubTab`, `_settingsGithubSignIn`, `_settingsGithubDisconnect` |

### 测试

| 测试文件 | 覆盖 |
|----------|------|
| `tests/services/worktree.test.ts` | stateless 重构 + 并发 cwd 隔离 |
| `tests/services/stack-detector.test.ts` | 19 个 detector 用例 |
| `tests/services/state-projects.test.ts` | repoPath/cloneStatus 生命周期 + getProjectRepoRoot |
| `tests/routes/projects.test.ts` | clone endpoint 全路径 + redirect logic |
| `tests/routes/projects-url-helpers.test.ts` | redact + inject URL helpers (BUG #1 + #9) |
| `tests/routes/storage-mode.test.ts` | storage-mode 路由 (含 mongo fake handle) |
| `tests/routes/github-oauth.test.ts` | Device Flow 全状态机 + repos endpoint |
| `tests/routes/self-update-dry-run.test.ts` | validateBuildReadiness pre-check |
| `tests/infra/mongo-backing-store.test.ts` | write-behind cache + flush + seed |
| `tests/infra/module-load.test.ts` | **39 个文件 import smoke** (catches ESM/require crashes) |
| `tests/integration/multi-repo-clone.smoke.test.ts` | real-git file:// → clone → worktree |

### 运维

| 文件 | 用途 |
|------|------|
| `cds/exec_cds.sh` | `install_systemd_cmd()`, `install_deps()` (sentinel 版本) |
| `cds/systemd/cds-master.service` | unit 模板（含 ExecStartPre 自愈）|
| `cds/Dockerfile.master` | 容器化部署 + bind-mount 文档（`/repo` + `/worktrees` + `/repos`）|

## 十、给下一棒的开场指令

```
你好，我是接 76ox4 会话的下一棒。

baseline:
- 分支 claude/phase-a-handoff-76ox4 (or main if merged)
- commit 21 个 P4 Part 18 改动已落地
- 529 测试全绿
- CDS 在 cds.miduo.org 实跑，核心 9 endpoints 已 smoke 验证
- systemd unit 准备好但需要用户手动执行 `cd cds && ./exec_cds.sh install-systemd`

我手上的 baseline 是 doc/report.cds-phase-b-e-handoff-2026-04-14.md。请：
1. 读完这份报告的"八、已知限制"和"follow-up 候选"
2. 跟用户确认下一阶段的优先级 (P5 user model? P6 webhook? 还是 follow-up 小修?)
3. /plan-first 给方案后再动手
4. 完成后 /handoff 写下一份报告
```

---

> **会话 76ox4 总结**: 21 commits, +134 tests, 11 new endpoints, 9 hardening commits, 1 manually-recovered bootstrap trap, 8 audit bugs found-and-fixed via /human-verify, 1 systemd unit syntax bug found via systemd-analyze, 0 outstanding placeholders in user-clickable surfaces.

