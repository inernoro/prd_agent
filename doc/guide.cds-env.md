# CDS 环境变量配置指南

> **类型**：操作指南 (How-to) | **日期**：2026-03-13 | **版本**：v1.0

---

## 1. 概述

CDS（Cloud Development Suite）的环境变量分为两层：

| 层级 | 配置位置 | 作用对象 | 生命周期 | 隔离性 |
|------|----------|----------|----------|--------|
| **系统层** | `.bashrc` / 系统环境变量 | CDS 进程本身 | 随 shell 会话 | 所有项目共享 |
| **项目层** | CDS Dashboard UI | 被部署的业务容器 | 持久化到 `.cds/state.json` | 按项目隔离 |

**核心原则**：

- CDS 自身的环境变量统一使用 `CDS_` 前缀，配置在 `.bashrc`
- 业务应用的环境变量（数据库、云存储、密钥等）配置在 CDS Dashboard UI
- 两者职责不混淆：`.bashrc` 管"CDS 怎么跑"，Dashboard UI 管"业务容器里有什么"

---

## 2. 系统层环境变量（.bashrc）

这些变量控制 CDS 进程本身的行为，必须在 CDS 启动前设置。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `CDS_USERNAME` | 推荐 | — | Dashboard 登录用户名（设置后启用认证） |
| `CDS_PASSWORD` | 推荐 | — | Dashboard 登录密码 |
| `CDS_JWT_SECRET` | 推荐 | dev 默认值 | JWT 签名密钥（生产环境必须 >= 32 字节） |
| `CDS_SWITCH_DOMAIN` | 可选 | — | 分支切换域名（如 `switch.miduo.org`） |
| `CDS_MAIN_DOMAIN` | 可选 | — | 主域名（如 `miduo.org`） |
| `CDS_PREVIEW_DOMAIN` | 可选 | — | 预览域名后缀（如 `miduo.org`） |
| `BT_NGINX_ENABLE` | 可选 | — | 设为 `1` 启用 Nginx 反向代理（端口 58000） |

> **向后兼容**：旧前缀 `BT_USERNAME` / `BT_PASSWORD` / `SWITCH_DOMAIN` / `MAIN_DOMAIN` / `PREVIEW_DOMAIN` / `JWT_SECRET` 仍可使用，但 `CDS_` 前缀优先级更高。新部署请统一使用 `CDS_` 前缀。

### 配置示例（.bashrc）

```bash
# ── CDS 系统配置 ──
export CDS_USERNAME="admin"
export CDS_PASSWORD="your-secure-password"
export CDS_JWT_SECRET="your-jwt-secret-at-least-32-bytes!!"
export CDS_SWITCH_DOMAIN="switch.miduo.org"
export CDS_MAIN_DOMAIN="miduo.org"
export CDS_PREVIEW_DOMAIN="miduo.org"
```

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

### 4.1 一键部署（推荐）

```bash
cd prd_agent/cds
./exec_setup.sh
```

脚本会交互式引导你完成以下 4 步：

```
步骤 1/4: Dashboard 认证 → 输入用户名、密码
步骤 2/4: JWT 签名密钥   → 输入或自动生成
步骤 3/4: 域名配置       → 主域名、切换域名、预览域名
步骤 4/4: 确认并写入     → 写入 .bashrc + 生成 Nginx 配置
```

完成后脚本会：
- 将 `CDS_*` 系统变量写入 `~/.bashrc`
- 在 `cds/nginx/` 下生成收拢后的 Nginx 配置文件
- 可选自动部署到宿主机 Nginx 容器

其他用法：

```bash
./exec_setup.sh --show        # 查看当前配置
./exec_setup.sh --nginx-only  # 仅重新生成 Nginx 配置
```

### 4.2 手动部署（逐步）

```
步骤 1: 配置 .bashrc（系统层）
         ↓
步骤 2: 配置 Nginx（宿主机）
         ↓
步骤 3: 启动 CDS
         ↓
步骤 4: 登录 Dashboard
         ↓
步骤 5: 配置项目环境变量（Dashboard UI）
         ↓
步骤 6: 添加构建配置（Build Profile）
         ↓
步骤 7: 添加分支 → 部署
```

#### 步骤 1：配置 .bashrc

```bash
cat >> ~/.bashrc << 'EOF'

# ── CDS 系统配置 ──
export CDS_USERNAME="admin"
export CDS_PASSWORD="your-password"
export CDS_JWT_SECRET="your-jwt-secret-at-least-32-bytes!!"
export CDS_SWITCH_DOMAIN="switch.miduo.org"
export CDS_MAIN_DOMAIN="miduo.org"
export CDS_PREVIEW_DOMAIN="miduo.org"
EOF

source ~/.bashrc
```

#### 步骤 2：配置 Nginx

宿主机 Nginx 配置已收拢为两个文件（详见第 8 节）：

```bash
# 生成配置
cd prd_agent/cds && ./exec_setup.sh --nginx-only

# 部署到宿主机
cp cds/nginx/nginx.conf /root/inernoro/nginx/nginx.conf
mkdir -p /root/inernoro/nginx/conf.d
cp cds/nginx/cds-nginx.conf /root/inernoro/nginx/conf.d/cds.conf

# 测试 + 重载
docker exec nginx_miduo nginx -t && docker exec nginx_miduo nginx -s reload
```

#### 步骤 3：启动 CDS

```bash
cd prd_agent/cds

# 前台运行（首次建议前台，便于观察日志）
./exec_branch_tester.sh

# 或后台运行
./exec_branch_tester.sh --background
```

启动成功后会看到：

```
  Cloud Development Suite
  ──────────────────────
  Dashboard:  http://localhost:9900
  Worker:     http://localhost:5500
  Switch:     switch.miduo.org → miduo.org
  Preview:    *.miduo.org
```

#### 步骤 4：登录 Dashboard

浏览器访问 `https://cds.miduo.org`（或 `http://localhost:9900`），输入步骤 1 设置的用户名密码。

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

### 4.2 日常操作

| 场景 | 操作 |
|------|------|
| 修改业务密钥（如更换 COS Key） | Dashboard UI → 环境变量 → 修改 → 重新部署相关分支 |
| 修改 CDS 登录密码 | 修改 `.bashrc` 中的 `CDS_PASSWORD` → 重启 CDS |
| 新增分支 | Dashboard → 输入分支名 → 添加 → 部署 |
| 切换活跃分支 | Dashboard → 点击分支卡片的"激活"按钮 |
| 查看容器实际环境变量 | Dashboard → 分支卡片 → 齿轮菜单 → "查看环境变量" |

### 4.3 多项目扩展（未来规划）

当前 CDS 为单项目架构（prd_agent），环境变量通过 `.cds/state.json` 的 `customEnv` 统一管理。

未来扩展到多项目时的隔离方案：

```
.bashrc (系统层)
├── CDS_USERNAME / CDS_PASSWORD    ← 全局共享，CDS 进程级
├── CDS_JWT_SECRET                  ← 全局共享
└── CDS_SWITCH_DOMAIN ...           ← 全局共享

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
- `.bashrc` 中只放 `CDS_` 前缀的系统变量（6 个）
- 所有业务变量都走 Dashboard UI，天然按项目隔离
- 即使未来多项目，`.bashrc` 中的变量不需要变，只有 Dashboard UI 需要按项目分组

---

## 5. 环境变量流转图

```
┌─────────────────┐
│    .bashrc       │  系统层：CDS 进程读取
│  CDS_USERNAME    │
│  CDS_PASSWORD    │──→ CDS 进程启动 → Dashboard 认证
│  CDS_JWT_SECRET  │──→ JWT 签名 + 注入容器 Jwt__Secret
│  CDS_*_DOMAIN    │──→ 域名路由配置
└─────────────────┘

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

### 7.1 收拢前 vs 收拢后

**收拢前**：宿主机 `nginx.conf` 里有 3 个几乎相同的 server 块（miduo.org / switch.miduo.org / cds.miduo.org），每个都重复完整的 SSL + proxy 配置。

**收拢后**：拆为两个文件，职责清晰：

| 文件 | 内容 | 变化频率 |
|------|------|----------|
| `nginx.conf` | 全局配置（worker、mime、log、websocket map） | 几乎不变 |
| `conf.d/cds.conf` | CDS 的 4 个 server 块 + upstream 定义 | 域名/端口变更时更新 |

### 7.2 文件结构

```
cds/nginx/
├── nginx.conf.template      # 主 nginx.conf 模板（精简，只有全局配置）
├── cds-nginx.conf.template   # CDS server 块模板（4 个域名）
├── nginx.conf                # 生成的主配置（exec_setup.sh 生成）
└── cds-nginx.conf            # 生成的 CDS 配置（exec_setup.sh 生成）
```

### 7.3 域名路由

```
                          ┌────────────────┐
  miduo.org ──────────────┤                │
  *.miduo.org ────────────┤  cds_worker    ├──► localhost:5500 (CDS Worker)
  switch.miduo.org ───────┤  (upstream)    │
                          └────────────────┘

  cds.miduo.org ──────────┬────────────────┐
                          │  cds_dashboard ├──► localhost:9900 (CDS Dashboard)
                          └────────────────┘
```

### 7.4 宿主机挂载

```bash
# 容器 nginx_miduo 的挂载关系
docker run -d \
  --name nginx_miduo \
  -v /root/inernoro/nginx/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /root/inernoro/nginx/conf.d:/etc/nginx/conf.d:ro \     # 新增！
  -v /root/inernoro/nginx/certs:/etc/nginx/certs:ro \
  -v /root/inernoro/nginx/www:/var/www/html \
  -p 80:80 -p 443:443 \
  nginx:alpine
```

> **注意**：如果容器之前没有挂载 `conf.d/` 目录，需要重建容器添加此挂载。或者直接在旧 `nginx.conf` 的 `http {}` 块末尾加一行 `include /etc/nginx/conf.d/*.conf;`。

### 7.5 模板占位符

| 占位符 | 默认值 | 说明 |
|--------|--------|------|
| `{{MAIN_DOMAIN}}` | — | 主域名（如 miduo.org） |
| `{{PREVIEW_DOMAIN}}` | 同 MAIN_DOMAIN | 预览子域名后缀 |
| `{{WORKER_PORT}}` | 5500 | CDS Worker 端口 |
| `{{MASTER_PORT}}` | 9900 | CDS Dashboard 端口 |

---

## 8. 安全注意事项

1. **不要将密码类变量提交到 Git**：`.cds/state.json` 已在 `.gitignore` 中
2. **生产环境必须设置 `CDS_JWT_SECRET`**：默认值仅供开发使用
3. **生产环境必须设置 `CDS_USERNAME` + `CDS_PASSWORD`**：否则 Dashboard 无认证保护
4. **`GITHUB_PAT` 不要配在 CDS Dashboard 中**：业务容器不需要，避免泄露
