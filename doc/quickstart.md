# PRD Agent 快速部署指南

从零到公网可访问的完整步骤。

## 前置条件

- Linux 服务器（Ubuntu 20.04+）
- Docker + Docker Compose
- 公网 IP 或域名（可选）
- Nginx（宿主机，用于公网转发）

## 第一步：启动服务

### 方式 A：一键部署（推荐）

```bash
# 创建 Docker 网络
docker network create prdagent-network 2>/dev/null || true

# 设置环境变量
export JWT_SECRET="$(openssl rand -base64 32)"
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"

# 资产存储（如果不用腾讯 COS，改为 local）
export ASSETS_PROVIDER="local"

# 一键部署
./exec_dep.sh
```

### 方式 B：本地构建部署

```bash
docker network create prdagent-network 2>/dev/null || true

export JWT_SECRET="$(openssl rand -base64 32)"
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"
export ASSETS_PROVIDER="local"

./local_exec_dep.sh up
```

### 方式 C：开发环境

```bash
export JWT_SECRET="YourSuperSecretKeyForJwtTokenGeneration2024!"
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="Admin123!"

docker compose -f docker-compose.dev.yml up -d --build
```

部署完成后，内部访问地址为 `http://localhost:5500`。

## 第二步：设置账号密码

### Root 破窗账户（首次登录）

通过环境变量设置 Root 账户，无需入库：

```bash
# 在 docker-compose 启动前设置
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="YourStrongPassword123!"
```

登录方式：
1. 浏览器访问 `http://localhost:5500`
2. 使用上面设置的用户名密码登录（clientType 为 admin）

### 创建正式用户

Root 登录后，在管理后台 → 用户管理中创建正式用户，或通过 API：

```bash
# 先用 Root 账号登录获取 token
TOKEN=$(curl -s http://localhost:5500/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YourStrongPassword123!","clientType":"admin"}' \
  | jq -r '.data.accessToken')

# 通过管理 API 创建用户（在管理后台操作更方便）
```

> Root 账户仅作为"破窗"用途，建议创建正式管理员账号后，移除 ROOT_ACCESS 环境变量。

## 第三步：配置 Nginx 公网转发

### 安装宿主机 Nginx

```bash
apt update && apt install -y nginx
```

### 配置反向代理

```bash
# 复制示例配置
cp deploy/nginx/public-nginx.example.conf /etc/nginx/sites-available/prdagent.conf

# 修改域名（替换 your-domain.com 为实际域名或公网 IP）
sed -i 's/your-domain.com/your-domain.com/g' /etc/nginx/sites-available/prdagent.conf

# 启用站点
ln -sf /etc/nginx/sites-available/prdagent.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default  # 移除默认站点（可选）

# 验证配置
nginx -t

# 重载
systemctl reload nginx
```

配置要点：
- 宿主机 Nginx 监听 80 端口，转发到 `127.0.0.1:5500`（Docker gateway）
- SSE 流式响应需要 `proxy_buffering off` + 长超时
- `client_max_body_size 30m` 支持文件上传

### 配置 HTTPS（推荐）

```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx

# 自动配置 SSL 证书
certbot --nginx -d your-domain.com

# 自动续期（certbot 默认已配置 systemd timer）
certbot renew --dry-run
```

### 直接使用 IP（无域名）

如果没有域名，修改 nginx 配置中的 `server_name` 为 `_`：

```nginx
server_name _;
```

然后通过 `http://公网IP` 访问。

## 第四步：验证部署

```bash
# 检查容器运行状态
docker ps | grep prdagent

# 测试 API 健康
curl http://localhost:5500/api/v1/health

# 测试登录
curl -X POST http://localhost:5500/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YourStrongPassword123!","clientType":"admin"}'

# 测试公网访问（替换为实际域名或 IP）
curl http://your-domain.com/api/v1/health
```

## 架构图

```
公网用户
  │
  ▼
[宿主机 Nginx :80/:443]  ← 公网入口，SSL 终止
  │
  ▼
[Docker gateway :5500]    ← 内部 nginx，SPA + API 反代
  │
  ├─ 静态文件 → /usr/share/nginx/html (prd-admin dist)
  │
  └─ /api/* → [API container :8080]
                  │
                  ├─ MongoDB
                  └─ Redis
```

## 环境变量速查

| 变量 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `JWT_SECRET` | 生产必填 | JWT 签名密钥（32+ 字符） | `openssl rand -base64 32` |
| `ROOT_ACCESS_USERNAME` | 首次 | 破窗管理员用户名 | `admin` |
| `ROOT_ACCESS_PASSWORD` | 首次 | 破窗管理员密码 | `YourStrongPassword123!` |
| `ASSETS_PROVIDER` | 否 | 资产存储方式 | `local` / `tencentCos` |
| `TENCENT_COS_*` | COS 时 | 腾讯云 COS 配置 | 见 docker-compose.yml |

## 常见问题

### Q: 端口 5500 被占用？

修改 docker-compose.yml 中 gateway 的端口映射，以及公网 nginx 中的 proxy_pass 端口：

```yaml
# docker-compose.yml
gateway:
  ports:
    - "15500:80"  # 改为其他端口
```

### Q: 忘记 Root 密码？

重新设置环境变量并重启 API 容器：

```bash
export ROOT_ACCESS_USERNAME="admin"
export ROOT_ACCESS_PASSWORD="NewPassword123!"
docker compose restart api
```

### Q: 如何初始化应用配置？

Root 登录管理后台后，进入"模型管理"页面，点击"初始化应用"按钮。
