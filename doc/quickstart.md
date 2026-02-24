# PRD Agent 快速部署指南

## Branch-Tester 一键部署

```bash
# 最简一条命令：基础设施 + Dashboard + Nginx 公网全搞定
./exec_bt.sh

# 后台运行
./exec_bt.sh --background

# 查看状态
./exec_bt.sh --status

# 停止
./exec_bt.sh --stop
```

默认会：
1. 检查/安装 Node.js 20+、pnpm、nginx
2. 启动 MongoDB、Redis、Gateway 容器
3. 配置公网 Nginx（应用 :80 + Dashboard :9900）
4. 启动 Branch-Tester

默认账号：`admin` / `PrdAgent123!`

### 自定义

```bash
# 自定义账号密码
ROOT_ACCESS_USERNAME="myuser" ROOT_ACCESS_PASSWORD="MyPass123!" ./exec_bt.sh

# 自定义端口
NGINX_APP_PORT=8080 NGINX_DASH_PORT=58000 ./exec_bt.sh

# 跳过 nginx（已有自己的 nginx 配置）
SKIP_NGINX=1 ./exec_bt.sh

# Dashboard 加认证
BT_USERNAME=admin BT_PASSWORD=secret ./exec_bt.sh
```

---

## 架构

```
公网用户
  │
  ├─ :80 (应用) ──→ [宿主机 Nginx] ──→ [gateway :5500] ──→ 当前激活分支
  │                                           │
  │                                           ├─ main:       API(:9001) + Vite
  │                                           ├─ feature-x:  API(:9002) + Vite
  │                                           └─ [未激活 → 502]
  │
  └─ :9900 (Dashboard) ──→ [宿主机 Nginx] ──→ [Branch-Tester :9900]
```

### 关键理解

- **:5500** = 可切换网关，在 Dashboard 中激活某个分支后才有内容
- **:9900** = 分支管理面板，启动/停止/切换分支
- **:9001+** = 各分支 API 直连端口（调试用）

---

## 部署后操作

### 激活分支

1. 浏览器访问 `http://公网IP:9900`（Dashboard）
2. 选择分支，点击 Run 或 Deploy
3. 激活后通过 `http://公网IP` 访问应用

### 登录应用

1. 访问 `http://公网IP`
2. 用户名 / 密码：`admin` / `PrdAgent123!`（或你自定义的）
3. clientType 选 `admin`

### 创建正式用户

Root 登录管理后台 → **用户管理** 创建正式账号。

### 初始化应用配置

首次部署后：管理后台 → **模型管理** → **初始化应用**。

---

## 独立部署（生产环境）

不需要 Branch-Tester 时，直接用 docker-compose：

```bash
export JWT_SECRET="$(openssl rand -base64 32)"
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"
export ASSETS_PROVIDER="local"

# 一键部署（拉取远程镜像）
./exec_dep.sh

# 或本地构建
./local_exec_dep.sh up
```

公网 Nginx 手动配置参考 `deploy/nginx/public-nginx.example.conf`。

---

## 环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ROOT_ACCESS_USERNAME` | `admin` | 管理员用户名 |
| `ROOT_ACCESS_PASSWORD` | `PrdAgent123!` | 管理员密码 |
| `JWT_SECRET` | 自动生成 | JWT 签名密钥 |
| `ASSETS_PROVIDER` | `local` | 资产存储：`local` / `tencentCos` |
| `NGINX_APP_PORT` | `80` | 应用公网端口 |
| `NGINX_DASH_PORT` | `9900` | Dashboard 公网端口 |
| `SKIP_NGINX` | — | 设为 `1` 跳过 nginx 配置 |
| `BT_USERNAME` | — | Dashboard 认证用户名 |
| `BT_PASSWORD` | — | Dashboard 认证密码 |

## HTTPS

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

## 忘记密码？

```bash
ROOT_ACCESS_PASSWORD="NewPass123!" ./exec_bt.sh --stop && ./exec_bt.sh --background
```
