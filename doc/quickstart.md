# PRD Agent 快速部署指南

从零到公网可访问的完整步骤。

## 前置条件

- Linux 服务器（Ubuntu 20.04+）
- Docker + Docker Compose
- 公网 IP 或域名（可选）
- Nginx（宿主机，用于公网转发）

---

## 部署模式选择

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **Branch-Tester** | 多分支同时运行，dashboard 切换激活分支 | 开发/测试环境 |
| **独立部署** | docker-compose 单实例，固定 gateway | 生产环境 |

两种模式都通过 **gateway(:5500)** 对外提供服务，区别在于 gateway 内部如何路由。

---

## 模式 A：Branch-Tester（你当前的环境）

### 架构

```
公网用户
  │
  ▼
[宿主机 Nginx :80/:443]          ← 公网入口，SSL 终止
  │
  ▼
[prdagent-gateway :5500]         ← 可切换网关（symlink 指向激活分支的 nginx conf）
  │
  ├─ 分支 main:
  │   ├─ prdagent-run-main        (:9001 → :8080)  API
  │   └─ prdagent-run-main-web                      Vite dev server
  │
  ├─ 分支 feature-x:
  │   ├─ prdagent-run-feature-x   (:9002 → :8080)  API
  │   └─ prdagent-run-feature-x-web                 Vite dev server
  │
  └─ [未激活时返回 502: "No active branch connected"]

[Branch-Tester Dashboard :9900]  ← 分支管理面板（启动/停止/切换分支）
```

**关键理解**：
- `:5500` 不是某个固定应用，而是**可切换网关**
- 在 dashboard(:9900) 中"激活"某个分支后，gateway 才会路由到该分支
- 每个分支的 API 也有直连端口（如 `:9001`），但建议通过 gateway 访问

### 启动步骤

```bash
cd branch-tester

# 设置环境变量（会透传给所有分支容器）
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"

# 启动 branch-tester
./exec_branch_tester.sh
# 或后台启动
./exec_branch_tester.sh --background
```

### 激活分支

1. 浏览器访问 `http://服务器IP:9900`（dashboard）
2. 选择要激活的分支，点击 "Activate"
3. gateway(:5500) 开始路由到该分支

---

## 模式 B：独立部署（生产环境）

### 架构

```
公网用户
  │
  ▼
[宿主机 Nginx :80/:443]  ← 公网入口，SSL 终止
  │
  ▼
[prdagent-gateway :5500]  ← 固定网关（SPA 静态文件 + API 反代）
  │
  ├─ 静态文件 → /usr/share/nginx/html (prd-admin dist)
  │
  └─ /api/* → [prdagent-api :8080]
                  │
                  ├─ MongoDB
                  └─ Redis
```

### 启动步骤

```bash
# 创建 Docker 网络
docker network create prdagent-network 2>/dev/null || true

# 设置环境变量
export JWT_SECRET="$(openssl rand -base64 32)"
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"
export ASSETS_PROVIDER="local"  # 不用腾讯 COS 则设为 local

# 方式 1：一键部署（拉取远程镜像 + 下载前端 dist）
./exec_dep.sh

# 方式 2：本地构建部署（无需远程镜像）
./local_exec_dep.sh up

# 方式 3：开发环境（暴露所有端口）
docker compose -f docker-compose.dev.yml up -d --build
```

---

## 设置账号密码

### Root 破窗账户（首次登录）

通过环境变量设置，不入库，容器重启即生效：

```bash
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"
```

- **独立部署**：在 `docker compose up` 之前设置
- **Branch-Tester**：在 `exec_branch_tester.sh` 之前设置，会自动透传给所有分支容器

登录方式：
1. 浏览器访问应用地址
2. 用户名 / 密码填上面设置的值
3. clientType 选 `admin`

### 创建正式用户

Root 登录管理后台后，在 **用户管理** 页面创建正式账号。

> Root 账户仅作为"破窗"用途，建议创建正式管理员账号后移除 `ROOT_ACCESS_*` 环境变量。

### 忘记密码？

```bash
# 重新设置环境变量并重启
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="NewPassword123!"

# 独立部署
docker compose restart api

# Branch-Tester：重启 branch-tester 即可
```

---

## 配置 Nginx 公网转发

### 安装宿主机 Nginx

```bash
apt update && apt install -y nginx
```

### 配置反向代理

```bash
# 复制示例配置
cp deploy/nginx/public-nginx.example.conf /etc/nginx/sites-available/prdagent.conf

# 修改域名
vim /etc/nginx/sites-available/prdagent.conf
# 将 your-domain.com 替换为你的域名或公网 IP

# 启用站点
ln -sf /etc/nginx/sites-available/prdagent.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default  # 移除默认站点（可选）

# 验证 & 重载
nginx -t && systemctl reload nginx
```

核心逻辑：**宿主机 Nginx(:80) → gateway(:5500) → 当前激活分支 / 固定 API**

### 无域名直接用 IP

修改 `server_name` 为 `_`：

```nginx
server_name _;
```

通过 `http://公网IP` 访问。

### 配置 HTTPS（推荐）

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
certbot renew --dry-run
```

### 公网暴露 Branch-Tester Dashboard（可选）

在 `public-nginx.example.conf` 中取消 dashboard server block 的注释，并配置子域名。
**强烈建议**加 IP 白名单或 BasicAuth，避免公网直接暴露管理面板。

---

## 验证部署

```bash
# 检查容器状态
docker ps | grep prdagent

# 测试 API（通过 gateway）
curl http://localhost:5500/api/v1/health

# 测试登录
curl -X POST http://localhost:5500/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YourStrongPassword123!","clientType":"admin"}'

# 测试公网
curl http://your-domain.com/api/v1/health
```

---

## 环境变量速查

| 变量 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `JWT_SECRET` | 生产必填 | JWT 签名密钥（32+ 字符） | `openssl rand -base64 32` |
| `ROOT_ACCESS_USERNAME` | 首次 | 破窗管理员用户名 | `admin` |
| `ROOT_ACCESS_PASSWORD` | 首次 | 破窗管理员密码 | `YourStrongPassword123!` |
| `ASSETS_PROVIDER` | 否 | 资产存储：`local` / `tencentCos` | `local` |
| `TENCENT_COS_*` | COS 时 | 腾讯云 COS 配置 | 见 docker-compose.yml |
| `BT_USERNAME` | BT 时 | Branch-Tester dashboard 认证用户名 | `admin` |
| `BT_PASSWORD` | BT 时 | Branch-Tester dashboard 认证密码 | `secret` |

## 初始化应用配置

首次部署后，Root 登录管理后台 → **模型管理** → 点击 **初始化应用** 按钮。
