# CDS Self-Hosting（CDS 托管 CDS）· 技术设计 · 设计

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：已落地

**一句话**：验收自身改动原本只能对生产实例自更新、全员陪跑，本文讲怎么让它托管自己做隔离验收。
**谁该读**：做自身验收的工程师。
**读完能做什么**：说清自托管验收与生产自更新的风险差别。

---

> **更新**:2026-07-15

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
- **父实例数据镜像**（2026-09-16，`preview-mirror.ts`）：演示数据只有形状没有内容，每条分支都是停止态、空服务，关系卡 / 总览 / 部署页全是空态。现在父实例在部署预览实例分支时，把自己的数据脱敏后写成 `<worktree>/.cds/preview-mirror.json`（与子实例的 state.json 同目录，已 gitignore），子实例每次启动按它播种，静态形状快照退役为「没有镜像文件时」的兜底。镜像内容：项目（白名单字段）、构建配置（env 里敏感 key 与带凭据的值只留形状，URL 保留主机名让关系图还画得出基础设施连线）、分支（含 services 状态、部署时刻、提交 sha、父实例算好的预览地址与提交标题）、每条分支最近 3 条部署 run 与活动日志（过打码）、验收报告元数据、运行中容器近 30 分钟的指标点位（以「距采集多少秒」存，回放时锚到当下）。三条底线：**只读**（一律带 `mirror: { capturedAt, source }`，分支卡与抽屉标「镜像 · 采集于」，动作照旧禁用）；**不带凭据**（子实例不打父实例 API，纯文件单向；Agent Key / 凭据 / 授权表这些集合根本不进文件，写盘前 `findMirrorLeaks` 自检，命中即不写）；**不冒充**（状态按采集时刻原样搬，每处都能看出本实例上没有容器；托管 CDS 的项目自己不进镜像，免得套娃）。幂等：同一份镜像重复启动不动库，新镜像整体替换旧镜像播下的条目。

### 3.4 子实例对父实例的反向防护（2026-07-15 加固）

用户追问「子容器会不会伤到母体」后按 effective-env 实测补的三道闸：

- **secret 自清洗**：父 CDS 的全局变量注入不分项目（隔离穿透通道 3，实测 `LLMGW_ADMIN_PASSWORD` 被注入子实例容器）。预览实例在 load-env 阶段（早于 config 模块求值）按键名模式（PASSWORD/SECRET/TOKEN/API_KEY/ACCESS_KEY/PRIVATE_KEY/CREDENTIAL）清除 process.env 中的疑似密钥，仅保留子实例专用凭据 `CDS_PREVIEW_USERNAME` / `CDS_PREVIEW_PASSWORD`（清洗后重映射为 basic auth 门禁；通用 CDS_PASSWORD 一律清除，防父实例密码流入）。清除的键名（不含值）写启动日志留痕。
- **资源上限**：compose 加 `deploy.resources.limits`（memory 1536M / cpus 2）——子实例跑的是未合并代码，泄漏/死循环不许拖垮共享宿主。
- **API 直通隔离**：子实例服务端往 index.html 注入 `window.__CDS_PREVIEW_INSTANCE__` 标记，web 端据此关闭 `/_cds` 直通与兜底重试（否则 forwarder 会把子实例 dashboard 的请求送回父实例）。

仍然存在、需运维动作的：cds-self 项目环境变量必须配 `CDS_PREVIEW_USERNAME` + `CDS_PREVIEW_PASSWORD`（子实例接共享 infra 网、公网可达，无认证不可接受）。auth mode 自动归一化——有专用密码即 basic、无即 disabled，无需也不要配 CDS_AUTH_MODE（继承值一律不信任）。

2026-07-23 起，子实例可额外配置 `CDS_PREVIEW_SSO_*` 一键登录。启用时必须同时配置 `CDS_PREVIEW_PUBLIC_BASE_URL` 为该子实例的 HTTPS 预览根地址；清洗器会删除继承的父级公网地址，只把这个专用地址重映射为 `CDS_PUBLIC_BASE_URL`，确保授权回调仍指向当前子实例。地址缺失或不合法时 SSO 保持禁用，密码门禁仍可使用。清洗器会先保存这组子实例专用值，删除所有继承的父级密钥，再只把专用值重映射为 `CDS_SSO_*`。SSO 是密码门禁之外的第二种入口，不替代密码兜底。CDS 只认识通用的一次性票据提供方配置（授权地址、换票地址、client id/secret、显示名称），不包含 MAP 或其他身份平台的产品判断。身份入口在数据库保存授权码哈希和消费状态，使用唯一索引保证单次消费，并以 TTL 索引回收过期票据；可执行索引定义维护在 `scripts/mongodb-indexes.js`。

### 3.5 前端可感知

- 公开端点 `GET /api/instance-mode` → `{ previewInstance: boolean }`(登录前后都可读,兼做就绪探针);
- 底部身份提示只剩一条（2026-09-16）：父实例经 forwarder 注入的徽章在托管态自己长成「CDS 托管 CDS」变体（深绿严肃配色，首段固定「CDS 托管 CDS」，随后 sha 与分支名，末尾「部署 / docker 已禁用」；展开面板不给部署按钮，只留日志）。判据是 compose 声明进 profile.env 的 `CDS_PREVIEW_INSTANCE`，与子实例自己的判定同源（`profileHostsPreviewInstance`）。子实例侦测到页面里有父徽章（`#cds-widget`）就不再画自己的 pill；直连端口、没有父徽章时才保留同一套绿色文案的 pill 兜底，并带上镜像摘要「数据镜像自 X，采集于 HH:mm」（`/api/instance-mode` 的 `mirror` 字段）。此前是两条并排：父实例的绿色 sha 徽章 + 子实例的橙色警告 pill。

## 四、部署方式(操作手册)

1. 生产 CDS → 项目列表 → 新建项目,clone `https://github.com/inernoro/prd_agent.git`(第二个项目,与主项目并存);
2. 项目设置 → 一键导入 → 粘贴 `cds/cds-compose.selfhost.yml` 全文;
3. (必做)项目环境变量配置 `CDS_PREVIEW_USERNAME` + `CDS_PREVIEW_PASSWORD`（为子实例单独生成、勿复用父实例密码），给公网可达的子 CDS 上一道门；auth mode 自动归一化，无需配 CDS_AUTH_MODE；
4. (可选)配置 `CDS_PREVIEW_PUBLIC_BASE_URL` 与 `CDS_PREVIEW_SSO_*`，公网根地址填写该子实例的真实 HTTPS 预览入口，授权地址统一指向组织的主身份入口，登录完成后默认落 `/project-list`；
5. 在 cds-self 项目里创建目标 CDS 分支 → 部署 → 预览域名打开子 CDS dashboard 验收。

## 五、后续路线(本设计不实现,列出防丢)

1. **模拟执行器**:假构建/假部署动画,让"部署一条分支"的完整交互可在子 CDS 里走通;
2. **DinD 真部署**:privileged sidecar + 镜像缓存卷,子 CDS 真的能部署示例项目;
3. **实验田域名**:预留 `*.cdslab.miduo.org`(独立通配证书),父 forwarder 整域委托给"当前占用实验田"的子 CDS,孙子分支拿到真 HTTPS 域名;独占槽位,可扩 cdslab-1/2/3;
4. **webhook fan-out**:同仓库多项目的 push 事件分发 + 按分支前缀过滤,让 cds 分支 push 即部署到 cds-self。

## 六、关联

- `cds/src/services/preview-instance.ts` / `preview-instance-seed.ts` — 模式 SSOT 与 seed
- `cds/cds-compose.selfhost.yml` — cds-self 项目 compose 合同(粘贴导入)
- `.claude/rules/cross-project-isolation.md` — 通道 4(共享库)/通道 5(self-update 重启)是本设计要消灭的痛
- [doc/plan.cds.status.md](./plan.cds.status.md) — CDS 活状态与路线入口

## 七、风险与已知边界

- 子 CDS 认证默认 disabled(未配 CDS_PREVIEW_PASSWORD 时)——按 §四.3 配置 `CDS_PREVIEW_*` 专用凭据为**必做**(子实例接共享 infra 网、公网可达;secret 自清洗已消除密钥外溢面,但内网可达面仍在);
- 演示分支的"运行中"状态是 seed 出来的形状数据,点它的预览链接不会有真页面(分支卡有备注说明);
- 镜像来的分支「运行中」也是采集时刻的状态：日志、exec、实时 docker stats 在子实例上都拿不到（接口返回明确的预览实例说明），指标曲线是回放的镜像点位；镜像要**父实例**升级到带导出逻辑的版本之后、下一次部署预览实例分支时才会写入，在那之前子实例仍退回演示快照；
- 冷构建(两次 pnpm install + tsc + vite build)约 3-6 分钟,readiness 窗口已放到 1200s;
- 同仓库双项目会双份 clone(磁盘),janitor 只在父 CDS 生效,子实例无清理需求(无容器、state 随 worktree 回收)。

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 | 作用 |
|------|------|------|
| 六、关联 | `cds/tests/services/preview-instance.test.ts` | 拦截边界 + seed 幂等单测 |
