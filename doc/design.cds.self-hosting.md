# CDS Self-Hosting（CDS 托管 CDS）· 技术设计

> **类型**:design(怎么做) · **更新**:2026-07-15 · **状态**:MVP（预览实例）已实现,模拟执行器/DinD/实验田域名为后续路线

---

## 一、管理摘要

过去验收 CDS 自身的改动只有一条路:对**生产 CDS** 执行 self-update——切分支、重启进程,所有项目、所有 Agent 一起陪跑(隔离穿透清单通道 5 的已知风险)。结果是"每测一次,CDS 就不稳定一次"。

本设计让 **CDS 像托管别的项目一样托管自己**:CDS 相关分支 push 后,由生产 CDS 构建出一个容器化的**预览实例**(子 CDS),通过标准 v3 预览域名打开它的 dashboard,验收 UI / API 改动。生产 CDS 从此只在真正要发布时才 self-update。

MVP 的边界一句话:**子 CDS 只需要"自己能被预览",不需要"会干活"**。它不操作 docker、不构建别的项目、不发孙子预览域名;所有宿主操作被统一拦截成一句用户看得懂的提示。

## 二、背景与取舍

### 2.1 为什么不是"完整复刻一个 CDS"

完整复刻要解决三座大山,每一座的成本都远超 MVP 的收益:

| 难题 | 展开 | MVP 决策 |
|---|---|---|
| docker 从哪来 | 子 CDS 要部署项目就要 docker。挂宿主 socket 会和父 CDS 抢容器名/网络/路由(隔离穿透);DinD 需要 privileged + 冷镜像缓存 | **不给 docker**。宿主命令统一拦截 |
| 孙子预览域名 | `*.miduo.org` 通配证书只覆盖一层子域,`{分支}.{子cds}.miduo.org` 天然 HTTPS 不通;扁平编码要动 slug SSOT 且 63 字符 label 很快爆 | **不发孙子域名**。二期用固定实验田域 `*.cdslab.miduo.org`(一条 DNS + 一张独立通配证书,父 forwarder 整域委托) |
| webhook 归属 | GitHub webhook 按 repoFullName 只解析到第一个项目(`findProjectByRepoFullName` 取 first match),同仓库第二个项目收不到 push 事件 | **不 link GitHub**。手动建分支 + 部署;二期做 webhook fan-out 或按分支前缀路由 |

### 2.2 多构建挑战:为什么是独立项目而不是根 compose 加服务

把 `cds` 服务塞进根 `cds-compose.yml` 意味着**每个 MAP 业务分支都会构建一遍 CDS**(两次 pnpm install + tsc + vite build),纯浪费。因此 cds-self 是**第二个 CDS 项目**(同一仓库、独立 compose 合同 `cds/cds-compose.selfhost.yml`):主项目零感知,CDS 构建只发生在 cds-self 项目里手动部署的分支上。

同仓库双项目带来的次生问题及现状:

- **worktree 隔离**:WorktreeService 是无状态的、按项目传 repoRoot(P4 G1.2),双项目各自 clone,互不干扰;
- **webhook 二义性**:见 2.1,MVP 不 link,彻底回避;
- **构建缓存**:pnpm store 走独立 named volume(`cds-self-pnpm-store`),多个 cds 分支共享。

## 三、核心机制:预览实例模式(CDS_PREVIEW_INSTANCE=1)

SSOT:`cds/src/services/preview-instance.ts`。

### 3.1 宿主操作统一拦截

`PreviewInstanceShellExecutor` 装饰真实 ShellExecutor:任何 shell 片段(按 `&&` / `;` / `|` / 换行拆分,兼容 sudo / env / `VAR=x` 前缀与绝对路径)首命令命中 `docker / docker-compose / systemctl / journalctl / nginx / certbot / service` 即短路,返回 exitCode 1 + 中文提示"预览实例已禁用宿主操作命令"。git / node / pnpm 等原样放行(self-status 等只读能力保留)。

真正的安全底座是**容器根本不挂 docker.sock**;拦截层的职责是把失败变成一句人话。

### 3.2 越界能力逐项关闭

| 能力 | 处理 | 位置 |
|---|---|---|
| systemd 单元同步 | 跳过 | `index.ts` 启动段 |
| docker 启动对账(infra/app reconcile) | 跳过(否则空 docker 会把 seed 的 running 分支误翻 error) | `index.ts` 对账 IIFE |
| 后台服务(docker-events / janitor / scheduler / auto-lifecycle / infra-watchdog / auto-restart) | 整体不启动 | `startBackgroundServices()` 早退 |
| 资源占用采样(docker stats) / 预览金丝雀 | 不创建 | `index.ts` |
| self-update / self-force-sync | 403 `preview_instance`,文案指明"推送新 commit 即自动重建" | `routes/branches.ts` |
| 分支部署 `POST /branches/:id/deploy` | 403 `preview_instance`(与其跑到 git/docker 处抛裸错误,不如入口一句人话) | `routes/branches.ts` |

### 3.3 存储与数据

- **钉死 JSON store**(compose env `CDS_STORAGE_MODE=json`):绝不让子 CDS 连上父 CDS 的 mongo-split 库(隔离穿透通道 4)。state 落在分支 worktree 的 `.cds/state.json`(已 gitignore),分支删除随 worktree 一起回收。
- **首启 seed 演示数据**(`preview-instance-seed.ts`):空库时生成 1 个演示项目 + 3 条分支(running / error / idle)+ 构建配置 + 活动日志,保证每个页面打开有内容可验(guided-exploration)。所有条目在名称/备注里写明"演示数据",不冒充真实部署(no-rootless-tree)。非空库(比如误配了 mongo)一律不碰。

### 3.4 子实例对父实例的反向防护（2026-07-15 加固）

用户追问「子容器会不会伤到母体」后按 effective-env 实测补的三道闸：

- **secret 自清洗**：父 CDS 的全局变量注入不分项目（隔离穿透通道 3，实测 `LLMGW_ADMIN_PASSWORD` 被注入子实例容器）。预览实例在 load-env 阶段（早于 config 模块求值）按键名模式（PASSWORD/SECRET/TOKEN/API_KEY/ACCESS_KEY/PRIVATE_KEY/CREDENTIAL）清除 process.env 中的疑似密钥，仅保留子实例 basic auth 自用的 `CDS_PASSWORD`。清除的键名（不含值）写启动日志留痕。
- **资源上限**：compose 加 `deploy.resources.limits`（memory 1536M / cpus 2）——子实例跑的是未合并代码，泄漏/死循环不许拖垮共享宿主。
- **API 直通隔离**：子实例服务端往 index.html 注入 `window.__CDS_PREVIEW_INSTANCE__` 标记，web 端据此关闭 `/_cds` 直通与兜底重试（否则 forwarder 会把子实例 dashboard 的请求送回父实例）。

仍然存在、需运维动作的：cds-self 项目环境变量必须配 `CDS_AUTH_MODE=basic` + 账号密码（子实例接共享 infra 网、公网可达，无认证不可接受）。

### 3.5 前端可感知

- 公开端点 `GET /api/instance-mode` → `{ previewInstance: boolean }`(登录前后都可读,兼做就绪探针);
- Shell 顶部居中常驻 pill:"CDS 预览实例 — 仅用于验收 CDS 自身改动,部署 / docker 操作已禁用",防止把演示实例当生产(expectation-management)。

## 四、部署方式(操作手册)

1. 生产 CDS → 项目列表 → 新建项目,clone `https://github.com/inernoro/prd_agent.git`(第二个项目,与主项目并存);
2. 项目设置 → 一键导入 → 粘贴 `cds/cds-compose.selfhost.yml` 全文;
3. (建议)项目环境变量配置 `CDS_AUTH_MODE=basic` + `CDS_USERNAME` + `CDS_PASSWORD`,给公网可达的子 CDS 上一道门;
4. 在 cds-self 项目里创建目标 CDS 分支 → 部署 → 预览域名打开子 CDS dashboard 验收。

## 五、后续路线(本设计不实现,列出防丢)

1. **模拟执行器**:假构建/假部署动画,让"部署一条分支"的完整交互可在子 CDS 里走通;
2. **DinD 真部署**:privileged sidecar + 镜像缓存卷,子 CDS 真的能部署示例项目;
3. **实验田域名**:预留 `*.cdslab.miduo.org`(独立通配证书),父 forwarder 整域委托给"当前占用实验田"的子 CDS,孙子分支拿到真 HTTPS 域名;独占槽位,可扩 cdslab-1/2/3;
4. **webhook fan-out**:同仓库多项目的 push 事件分发 + 按分支前缀过滤,让 cds 分支 push 即部署到 cds-self。

## 六、关联

- `cds/src/services/preview-instance.ts` / `preview-instance-seed.ts` — 模式 SSOT 与 seed
- `cds/cds-compose.selfhost.yml` — cds-self 项目 compose 合同(粘贴导入)
- `cds/tests/services/preview-instance.test.ts` — 拦截边界 + seed 幂等单测
- `.claude/rules/cross-project-isolation.md` — 通道 4(共享库)/通道 5(self-update 重启)是本设计要消灭的痛
- `doc/plan.llm-gateway.rollout.md` — 看板范式;cds-self 若演进为多波工程需按 living-status-board 建看板

## 七、风险与已知边界

- 子 CDS 认证默认 disabled(未配 CDS_USERNAME/PASSWORD 时)——按 §四.3 配置 basic auth 为**必做**(子实例接共享 infra 网、公网可达;secret 自清洗已消除密钥外溢面,但内网可达面仍在);
- 演示分支的"运行中"状态是 seed 出来的形状数据,点它的预览链接不会有真页面(分支卡有备注说明);
- 冷构建(两次 pnpm install + tsc + vite build)约 3-6 分钟,readiness 窗口已放到 1200s;
- 同仓库双项目会双份 clone(磁盘),janitor 只在父 CDS 生效,子实例无清理需求(无容器、state 随 worktree 回收)。
