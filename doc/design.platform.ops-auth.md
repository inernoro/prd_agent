# 桌面端更新与分布式登录/会话审计说明 · 设计

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：已落地

**一句话**：桌面端自动更新的签名校验与分发方式，以及多实例部署下登录态为什么不会掉。
**谁该读**：做桌面端发布与登录的工程师。
**读完能做什么**：说清更新包怎么验签、会话怎么跨实例共享。

---

## 一、管理摘要

- **解决什么问题**：桌面端自动更新机制（签名校验、manifest 格式）和多实例部署下登录状态是否丢失的审计
- **方案概述**：Tauri Updater 基于 GitHub Releases 分发签名更新包；JWT + Redis 共享会话确保多实例无粘性部署不掉登录
- **业务价值**：保障桌面端安全自动更新，消除多实例部署的登录状态疑虑
- **影响范围**：桌面端（Tauri Updater 配置、CI/CD 签名流程）、后端（JWT 认证、Redis 会话）、运维（Nginx 配置）
- **预计风险**：低 — 已验证并部署，需注意 JWT_SECRET 和 Redis 一致性约束

---

## 1. 桌面端版本更新（Tauri Updater）

### 1.1 更新来源
- 更新源：GitHub Releases
- 客户端更新清单（manifest）：`latest-{{target}}.json`
  - `{{target}}`：**Rust target triple**（与 Release 资产命名一致），例如：
    - `aarch64-apple-darwin`
    - `x86_64-apple-darwin`
    - `x86_64-pc-windows-msvc`
    - `x86_64-unknown-linux-gnu`
- 默认 endpoint：`https://github.com/inernoro/prd_agent/releases/latest/download/latest-{{target}}.json`
  - 兼容兜底：客户端也会尝试 `latest.json`（全平台聚合 manifest）

### 1.2 签名与校验
- GitHub Actions 使用 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 对更新资产签名。
- 客户端需要内置 **public key** 进行验签：`prd-desktop/src-tauri/tauri.conf.json` 中的 `plugins.updater.pubkey`。

注意：仓库中不会存放任何私钥。`pubkey` 可以公开，但必须与 Actions 里使用的私钥配对，否则客户端会报“验签失败/无法安装更新”。

### 1.3 Release 资产要求
Release 必须包含：
- 各平台安装包（`.msi/.dmg/.deb/.AppImage`）
- 对应签名文件（`*.sig`）
- `latest-{{target}}.json`
  - 说明：manifest 通常不需要单独的 `.json.sig` 文件；关键是安装包的 `*.sig`（或 JSON 内的 signature 字段）
  - **重要**：`latest-*.json` 里的 `platforms[...].url` 必须与 Release 资产文件名 **完全一致**（区分空格/点号/大小写）。
    - 推荐统一用点号（例如 `PRD.Agent.app.tar.gz`），避免空格导致 URL 编码与重命名不一致引发 404。
    - 若你在 CI/上传前对产物做了重命名（比如 `PRD Agent` -> `PRD.Agent`），务必同步改写 `latest-*.json` 中的下载 URL。
    - 本仓库提供了脚本辅助（在上传前执行）：`scripts/normalize-updater-assets.sh <assets_dir>`

### 1.4 快速自检（排查 “Could not fetch a valid release JSON from the remote”）
- 直接在浏览器访问（按当前平台替换）：`https://github.com/inernoro/prd_agent/releases/latest/download/latest-{{target}}.json`
  - 若返回 `{"error":"Not Found"}` / 404 / HTML 页面：说明 Release 未上传 manifest（或文件名不一致）
- 检查该 Release 的 Assets 列表中是否存在：
  - `latest-{{target}}.json`
  - 以及安装包对应的 `*.sig`

## 2. 分布式登录/会话：Nginx 负载均衡是否会掉登录？

结论：**不会因为 Nginx 轮询到不同后端实例而“随机掉登录”**（前提：Redis 共享 + JWT Secret 一致）。

### 2.1 当前实现要点（代码级）
- **Access Token**：JWT Bearer，无服务端粘性会话依赖。
- **Refresh 会话**：存 Redis（3 天滑动过期，按端独立：`userId + clientType + sessionKey`）。
- **踢下线/撤销**：`tokenVersion` 存 Redis；JWT 在 `OnTokenValidated` 阶段会校验 tokenVersion，不一致立即拒绝（401）。
- **业务会话（Session）**：`SessionService` 使用 `ICacheManager`（Redis）存储会话状态与 TTL，不依赖单实例内存。

### 2.2 多实例部署的强制约束（必须满足）
- **所有后端实例必须使用同一份 `Jwt__Secret`**（否则会出现“偶发 401”，看起来像随机掉登录）。
  - docker-compose 生产：`docker-compose.yml` 已改为强制要求 `JWT_SECRET` 环境变量。
- **所有后端实例必须指向同一 Redis（或 Redis Cluster/Sentinel）**。
  - Redis 不可用时，token 校验会失败，表现为 401（安全兜底）。

### 2.3 Nginx/网关层建议
- 你们的 Nginx 已针对 SSE 做了关键设置（`proxy_buffering off` 等）。
- 由于认证不是 Cookie Session，不需要 sticky session（如 `ip_hash`）来“保登录”。

### 2.4 额外注意（可选优化）
- 当前限流中间件（`RateLimitMiddleware`）使用进程内状态，多实例下限流不一致；如果需要“全局一致限流”，应迁移到 Redis。

## 3. 统一授权健康诊断（2026-09-01）

### 3.1 解决什么问题

系统里有多套彼此独立的身份/凭据（用户会话、AI Access Key、Agent API Key、稳定冒烟签名、模型平台密钥、外部授权、CDS 项目身份、LLMGW 网关）。以前任何一套出问题（密钥转不开、会话过期、平台凭据解密失败），排查者只能翻各自的日志逐个猜；出问题时前端也分不清"是我要重新登录"还是"是某个不影响我登录状态的服务凭据坏了"。

### 3.2 方案概述

新增一个只读的**授权健康看板**（`GET /api/authorization-health`），聚合上述每一套身份的健康状态，逐项给出：健康 / 受阻 / 有条件（尚无运行证据）三态之一，附带判定依据（配置存在性、密文是否可解密、近 24 小时是否有对应的 401/403 请求）与出问题时的下一步建议。看板不保存、不返回任何明文凭据。

前端新增「授权健康中心」页面与导航入口，作为运维/管理员定位授权类问题的统一入口。

### 3.3 401 的可恢复诊断

以前所有认证失败一律 401，前端唯一能做的反应是"当作会话过期，刷新或退出登录"——这对 AI Access Key、Agent API Key、稳定冒烟签名失效同样会误触发登出，用户莫名其妙被踢下线。

现在每种认证方式的失败都会带上独立的诊断码，前端据此区分：
- **会话类 401**（JWT 过期/tokenVersion 不一致）→ 维持原有的刷新或退出逻辑
- **非会话类 401**（AI Access Key 失效、Agent API Key 被撤销、平台凭据解密失败等）→ 只提示"这项能力不可用"，**不刷新、不登出当前用户会话**

多种认证方案并行 challenge（同一请求可能同时携带 Bearer + AI Access Key）时，只写入一次结构化的 401 响应，避免响应体里出现互相矛盾的失败原因。

### 3.4 权限判断对齐

修正了 `super` 与 `root` 两种管理员身份在前端有效权限判断上的不一致，以及受限管理页对无权限用户的提示从"无声失败"改为明确的权限提示。
