# CDS 环境变量配置指南

> **类型**：操作指南 (How-to) | **日期**：2026-04-10 | **版本**：v2.0

---

## 1. 概述

CDS（Cloud Development Suite）的环境变量分为两层：

| 层级 | 配置位置 | 作用对象 | 生命周期 | 隔离性 |
|------|----------|----------|----------|--------|
| **系统层** | `cds/.cds.env` | CDS 进程本身 | 启动时 source | 所有项目共享 |
| **项目层** | CDS Dashboard UI | 被部署的业务容器 | 持久化到 `.cds/state.json` | 按项目隔离 |

**核心原则**：

- CDS 自身的环境变量统一使用 `CDS_` 前缀，写入 `cds/.cds.env`（`./exec_cds.sh init` 生成）
- 业务应用的环境变量（数据库、云存储、密钥等）配置在 CDS Dashboard UI
- 两者职责不混淆：`.cds.env` 管"CDS 怎么跑"，Dashboard UI 管"业务容器里有什么"

---

## 2. 系统层环境变量（cds/.cds.env）

这些变量控制 CDS 进程本身的行为，由 `./exec_cds.sh init` 交互式写入。**不再使用 `.bashrc`**，避免与 CDS 启动脚本之外的系统环境变量冲突。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `CDS_USERNAME` | 推荐 | — | Dashboard 登录用户名（设置后启用认证） |
| `CDS_PASSWORD` | 推荐 | — | Dashboard 登录密码 |
| `CDS_JWT_SECRET` | 推荐 | 自动生成 | JWT 签名密钥（init 首次运行自动生成 32 字节） |
| `CDS_ROOT_DOMAINS` | 推荐 | — | 根域名列表，逗号分隔（`miduo.org,mycds.net`） |
| `CDS_STORAGE_MODE` | 否 | `json` | State 持久化后端：`json`（文件）/`mongo`/`auto` |
| `CDS_AUTH_BACKEND` | 否 | `memory` | Auth 持久化后端：`memory`（重启丢失）/`mongo`（见 §2.1） |
| `CDS_MONGO_URI` | 条件 | — | MongoDB 连接串，`CDS_STORAGE_MODE=mongo` 或 `CDS_AUTH_BACKEND=mongo` 时必填 |
| `CDS_MONGO_DB` | 否 | `cds_state_db` | State 存储数据库名 |
| `CDS_AUTH_MONGO_DB` | 否 | `cds_auth_db` | Auth 存储数据库名（默认与 State DB 独立） |
| `CDS_SECRET_KEY` | 否 | — | 32 字节十六进制，启用后加密 state.json 中的 Device Flow token |

> **多域名**：`CDS_ROOT_DOMAINS` 可以同时配置多个，每个根域名 `D` 自动生成三条路由：
>
> - `D` → Dashboard
> - `cds.D` → Dashboard（别名）
> - `*.D` → Preview（任意子域名即分支预览）
>
> 例：`CDS_ROOT_DOMAINS="miduo.org,mycds.net"` 同时支持 `miduo.org`、`cds.miduo.org`、`branch-x.miduo.org`、`mycds.net`、`cds.mycds.net`、`branch-x.mycds.net`。

### 生成示例（由 `./exec_cds.sh init` 自动生成）

```bash
# cds/.cds.env
export CDS_USERNAME="admin"
export CDS_PASSWORD="your-secure-password"
export CDS_JWT_SECRET="自动生成的 32 字节随机串"
export CDS_ROOT_DOMAINS="miduo.org,mycds.net"
```

### 2.1 CDS_AUTH_BACKEND — Auth 持久化后端（FU-02）

> **问题**：默认的 `memory` 后端把用户和 session 存在进程内存，CDS 重启后所有用户需要重新登录。

| 值 | 说明 |
|----|------|
| `memory`（默认） | 进程内 Map，重启即清空。适合单节点开发/测试 |
| `mongo` | 持久化到 MongoDB，重启不掉 session，支持多实例共享登录态 |

**启用 MongoDB Auth 后端**：

```bash
# cds/.cds.env
export CDS_AUTH_BACKEND="mongo"
export CDS_MONGO_URI="mongodb://localhost:27017"
# 可选：Auth 和 State 使用不同的 DB
export CDS_AUTH_MONGO_DB="cds_auth_db"
```

**注意事项**：

- `CDS_AUTH_BACKEND` 和 `CDS_STORAGE_MODE` 是**两个独立开关**，可以自由组合（例如 state=json + auth=mongo）
- 从 `memory` 切换到 `mongo` 时，所有用户需要重新登录一次（历史 session 不迁移，这是预期行为）
- 首次登录的用户自动成为 system owner
- MongoDB 索引需要 DBA 手动维护（见 `.claude/rules/no-auto-index.md`）：
  - `cds_users.githubId`（unique）、`cds_users.id`（unique）
  - `cds_sessions.token`（unique）、`cds_sessions.userId`（non-unique）、`cds_sessions.expiresAt`（TTL，可选）
  - `cds_workspaces.slug`（unique）、`cds_workspaces.ownerId`（non-unique）
- **回滚**：删除 `CDS_AUTH_BACKEND=mongo`（或设为 `memory`）后重启即可，MongoDB 中的数据保留

---

## 3. 项目层环境变量（CDS Dashboard UI）

这些变量通过 CDS Dashboard 的"环境变量"面板配置，存储在 `.cds/state.json` 的 `customEnv` 字段中。部署分支时，这些变量会注入到业务容器中。

### 3.1 分类

#### 基础设施连接（必填）

| 变量 | 说明 | 示例 |
|------|------|------|
| `MONGODB_HOST` | MongoDB 地址 | `10.7.0.17:27017` |
| `MONGODB_PASSWORD` | MongoDB 密码 | `****` |
| `MongoDB__ConnectionString` | .NET 连接字符串 | `mongodb://root:****@10.7.0.17:27017/?authSource=admin` |
| `REDIS_HOST` | Redis 地址 | `10.7.0.17:6379` |
| `REDIS_PASSWORD` | Redis 密码 | `****` |
| `Redis__ConnectionString` | .NET 连接字符串 | `10.7.0.17:6379,password=****` |

#### 云存储（必填）

| 变量 | 说明 | 示例 |
|------|------|------|
| `ASSETS_PROVIDER` | 存储提供商 | `tencentCos` |
| `TENCENT_COS_BUCKET` | COS Bucket | `ap-tokyo-1251304948` |
| `TENCENT_COS_REGION` | COS 区域 | `ap-tokyo` |
| `TENCENT_COS_SECRET_ID` | COS SecretId | `AKID****` |
| `TENCENT_COS_SECRET_KEY` | COS SecretKey | `****` |
| `TENCENT_COS_PUBLIC_BASE_URL` | 公开访问域名 | `https://i.miduo.org` |

#### 应用认证（必填）

| 变量 | 说明 | 示例 |
|------|------|------|
| `ROOT_ACCESS_USERNAME` | 超管用户名 | `root` |
| `ROOT_ACCESS_PASSWORD` | 超管密码 | `****` |
| `AI_ACCESS_KEY` | AI 接口密钥 | `****` |

#### 部署配置（可选）

| 变量 | 说明 | 示例 |
|------|------|------|
| `PAGES_BASE_URL` | GitHub Pages 基础 URL | `https://inernoro.github.io/prd_agent` |

### 3.2 不应放在 CDS 中的变量

| 变量 | 原因 | 应配置在哪里 |
|------|------|-------------|
| `GITHUB_PAT` | 仅 CI/CD 和脚本使用，业务容器不需要 | CI 环境或 `.bashrc`（仅开发机） |

---

## 4. 操作说明书

### 4.1 一条命令完成初始化与启动

```bash
cd prd_agent/cds

# 1. 首次初始化 (交互式写入 .cds.env，并生成 nginx 配置)
./exec_cds.sh init

# 2. 启动 (默认后台启动 CDS + Nginx)
./exec_cds.sh start

# 3. (可选) 签发 Let's Encrypt 证书
./exec_cds.sh cert
```

`init` 会交互式引导：

```
CDS_USERNAME       [admin]: admin
CDS_PASSWORD       : ****
CDS_ROOT_DOMAINS   : miduo.org,mycds.net
```

JWT Secret 首次运行会自动生成，后续保持不变。完成后脚本会立即渲染 nginx 配置到 `cds/nginx/cds-site.conf`。

### 4.2 常用命令

```bash
./exec_cds.sh init          # 交互式初始化 (写 .cds.env 并渲染 nginx)
./exec_cds.sh start         # 启动 CDS + Nginx (默认后台)
./exec_cds.sh start --fg    # 前台启动 (首次调试或追踪日志时用)
./exec_cds.sh stop          # 停止 CDS + Nginx
./exec_cds.sh restart       # 重启
./exec_cds.sh status        # 查看运行状态
./exec_cds.sh logs          # 跟随 CDS 日志
./exec_cds.sh cert          # 签发/续签 Let's Encrypt 证书
```

> `daemon` / `--background` / `-d` 是 `start` 的历史别名，依旧可用；`fg` 是 `start --fg` 的别名。

### 4.3 访问 Dashboard

启动成功后访问任意根域名或 `cds.*` 别名，例如：

- `https://miduo.org` 或 `https://cds.miduo.org`
- `https://mycds.net` 或 `https://cds.mycds.net`

本地调试可直接访问 `http://localhost:9900`。

#### 步骤 5：配置项目环境变量

1. 点击 Dashboard 顶部的 **齿轮图标**（或"环境变量"按钮）
2. 逐个添加项目层环境变量（参见第 3 节的分类表）
3. 保存

> **提示**：环境变量保存后立即生效于后续部署。已运行的分支容器需要重新部署才能获取新变量。

#### 步骤 6：添加构建配置

在 Dashboard 的"构建配置"区域，确认已配置好 Build Profile（如 `prd-api`）。默认情况下首次添加分支时会提示创建。

#### 步骤 7：添加分支并部署

1. 在 Dashboard 输入远程分支名（如 `main` 或 `feature/xxx`）
2. 点击"添加分支" → 系统自动创建 git worktree
3. 点击"部署" → 构建 Docker 镜像并启动容器
4. 部署完成后通过 `:5500` 端口或 `https://miduo.org` 访问

### 4.4 日常操作

| 场景 | 操作 |
|------|------|
| 修改业务密钥（如更换 COS Key） | Dashboard UI → 环境变量 → 修改 → 重新部署相关分支 |
| 修改 CDS 登录密码 | `./exec_cds.sh init` 重新交互或手动编辑 `cds/.cds.env` → `./exec_cds.sh restart` |
| 新增根域名 | 编辑 `cds/.cds.env` 追加到 `CDS_ROOT_DOMAINS` → `./exec_cds.sh restart` |
| 新增分支 | Dashboard → 输入分支名 → 添加 → 部署 |
| 切换活跃分支 | Dashboard → 点击分支卡片的"激活"按钮 |
| 查看容器实际环境变量 | Dashboard → 分支卡片 → 齿轮菜单 → "查看环境变量" |

### 4.5 多项目扩展（未来规划）

当前 CDS 为单项目架构（prd_agent），环境变量通过 `.cds/state.json` 的 `customEnv` 统一管理。

未来扩展到多项目时的隔离方案：

```
cds/.cds.env (系统层)
├── CDS_USERNAME / CDS_PASSWORD    ← 全局共享，CDS 进程级
├── CDS_JWT_SECRET                  ← 全局共享
└── CDS_ROOT_DOMAINS                ← 全局共享

CDS Dashboard (项目层)
├── prd_agent/                      ← 项目 A 的 customEnv
│   ├── MongoDB__ConnectionString
│   ├── TENCENT_COS_*
│   └── ...
└── another_project/                ← 项目 B 的 customEnv（独立隔离）
    ├── MongoDB__ConnectionString   ← 可以不同的数据库
    └── ...
```

**当前阶段无需担心混用**：
- `cds/.cds.env` 中只放 `CDS_` 前缀的系统变量（4 个）
- 所有业务变量都走 Dashboard UI，天然按项目隔离
- 即使未来多项目，`cds/.cds.env` 中的变量不需要变，只有 Dashboard UI 需要按项目分组

---

## 5. 环境变量流转图

```
┌──────────────────┐
│  cds/.cds.env    │  系统层：exec_cds.sh 启动时 source
│  CDS_USERNAME    │
│  CDS_PASSWORD    │──→ CDS 进程启动 → Dashboard 认证
│  CDS_JWT_SECRET  │──→ JWT 签名 + 注入容器 Jwt__Secret
│  CDS_ROOT_DOMAINS│──→ nginx 路由生成 (Dashboard / cds.D / *.D)
└──────────────────┘

┌─────────────────┐
│  CDS Dashboard   │  项目层：用户通过 UI 配置
│  (customEnv)     │
│  MongoDB__*      │
│  Redis__*        │──→ docker run --env-file → 业务容器
│  TENCENT_COS_*   │
│  AI_ACCESS_KEY   │
│  ...             │
└─────────────────┘
```

**合并优先级**（部署时）：

```
customEnv (Dashboard UI)  ← 最低优先级
    ↓ 覆盖
Jwt__Secret / Jwt__Issuer ← CDS 自动注入
    ↓ 覆盖
VITE_GIT_BRANCH           ← CDS 自动注入
    ↓ 覆盖
profile.env (构建配置)     ← 最高优先级
```

---

## 6. API 参考

CDS 提供 REST API 管理项目层环境变量：

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/env` | 获取所有自定义环境变量 |
| `PUT` | `/api/env` | 批量设置所有环境变量（覆盖） |
| `PUT` | `/api/env/:key` | 设置/更新单个变量 |
| `DELETE` | `/api/env/:key` | 删除单个变量 |

### 示例

```bash
# 查看当前环境变量
curl -s http://localhost:9900/api/env | jq

# 设置单个变量
curl -X PUT http://localhost:9900/api/env/AI_ACCESS_KEY \
  -H "Content-Type: application/json" \
  -d '{"value": "new-key-value"}'

# 批量设置（覆盖所有）
curl -X PUT http://localhost:9900/api/env \
  -H "Content-Type: application/json" \
  -d '{"MONGODB_HOST": "10.7.0.17:27017", "REDIS_HOST": "10.7.0.17:6379"}'
```

---

## 7. Nginx 配置架构

### 7.1 生成的文件

`./exec_cds.sh init` 和 `./exec_cds.sh start` 都会根据 `.cds.env` 重新渲染以下三个文件（全部被 `.gitignore` 忽略）：

```
cds/nginx/
├── nginx.conf         # 全局配置 (worker / mime / log / websocket map)
├── cds-site.conf      # CDS 的 server 块 + upstream (根据 CDS_ROOT_DOMAINS)
├── nginx.compose.yml  # docker compose 文件，启动 cds_nginx 容器
├── certs/             # TLS 证书 (每个根域名一对 <domain>.crt / .key)
└── www/               # ACME webroot (Let's Encrypt 验证用)
```

容器名固定为 `cds_nginx`，`network_mode: host`，所以 CDS 直接监听 80/443。

### 7.2 多域名路由规则

对于 `CDS_ROOT_DOMAINS` 中每一个根域名 `D`，脚本自动生成两个 server 块：

```
# Dashboard
server { server_name D cds.D; location / { proxy_pass http://cds_master; } }

# Preview
server { server_name *.D;     location / { proxy_pass http://cds_worker; } }
```

Nginx 的精确匹配优先级高于通配符，所以 `cds.D` 不会被 `*.D` 误匹配。

```
                           ┌────────────────┐
  miduo.org ────────────┐  │                │
  cds.miduo.org ────────┤  │                │
  mycds.net ────────────┼──┤  cds_master    ├──► localhost:9900 (Dashboard)
  cds.mycds.net ────────┘  │                │
                           └────────────────┘

                           ┌────────────────┐
  *.miduo.org ──────────┐  │                │
  *.mycds.net ──────────┼──┤  cds_worker    ├──► localhost:5500 (Preview)
                        │  │                │
                           └────────────────┘
```

### 7.3 TLS 证书

`./exec_cds.sh cert` 会遍历 `CDS_ROOT_DOMAINS` 中每一个根域名，分别使用 `acme.sh` 签发 `D + cds.D`，并将证书写入 `cds/nginx/certs/<D>.crt|.key`。

**每个根域名独立签发、独立挂载**。如果某个域名还没有证书，该域名在渲染出的 `cds-site.conf` 里只会保留 `listen 80`；一旦证书出现，下次 `start` / `restart` 会自动补上 `listen 443 ssl`。

> 通配符 `*.D` 的 HTTPS 需要 DNS 挑战签发，本脚本默认使用 webroot 模式只签发精确域名。如果需要子域名 HTTPS，可以自行用 DNS API 签发后放到 `cds/nginx/certs/` 目录。

---

## 8. 安全注意事项

1. **不要将密码类变量提交到 Git**：`.cds/state.json` 已在 `.gitignore` 中
2. **生产环境必须设置 `CDS_JWT_SECRET`**：默认值仅供开发使用
3. **生产环境必须设置 `CDS_USERNAME` + `CDS_PASSWORD`**：否则 Dashboard 无认证保护
4. **`GITHUB_PAT` 不要配在 CDS Dashboard 中**：业务容器不需要，避免泄露
