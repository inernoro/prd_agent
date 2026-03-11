# CDS 部署规划

> **版本**：v1.0 | **日期**：2026-03-11 | **关联**：design.exec-bt-deployment.md, docker-compose.yml, cds/

## 1. 问题背景

当前系统存在三种部署模式，端口分配和职责边界不够清晰，尤其是：

- miduo.org 域名需要绑定 80/443，但应用使用 5500
- CDS 的 workerPort (5500) 和 PrdAgent Gateway (5500) 使用相同端口
- SSL 证书管理方式不明确
- CDS 和独立部署之间缺乏明确的切换流程

## 2. 端口全景

```
┌─── 公网入口层 (Host Nginx) ─────────────────────────────┐
│  :80  → 301 重定向到 :443                                 │
│  :443 → SSL 终止 → proxy_pass 127.0.0.1:5500             │
└───────────────────────────────┬───────────────────────────┘
                                │
     ┌──────── :5500 (二选一) ──┤
     │                          │
     ▼ 模式 A                   ▼ 模式 B
┌──────────────┐        ┌──────────────┐
│  prdagent-   │        │  CDS Worker  │
│  gateway     │        │  Proxy       │
│  (Docker)    │        │  (Node.js)   │
│  nginx:80    │        │              │
└──────┬───────┘        └──────┬───────┘
       │                       │
       ▼                       ▼
  api:8080              分支容器:9001+
  (单一后端)            (多分支后端)

另外:
  :9900 → CDS Dashboard (仅模式 B)
```

## 3. 三种部署模式对比

| 维度 | 模式 A: 独立部署 | 模式 B: CDS 分支测试 | 模式 C: 本地开发 |
|------|-----------------|---------------------|-----------------|
| 入口脚本 | `exec_dep.sh` | `exec_bt.sh` | `docker compose -f docker-compose.dev.yml up` |
| 占用 :5500 的组件 | prdagent-gateway (Docker) | CDS Worker Proxy (Node.js) | web 容器 (Docker) |
| 占用 :9900 | — | CDS Dashboard | — |
| 占用 :80/:443 | Host Nginx (可选) | Host Nginx (可选) | — |
| SSL | Host Nginx 终止 | Host Nginx 终止 | 无 |
| 适用场景 | 生产环境 | 测试/预览环境 | 开发机 |
| 切换条件 | 默认模式 | 需先停 prdagent-gateway | 独立环境，无冲突 |

## 4. 部署方案

### 4.1 生产部署 (模式 A)

**适用场景**：miduo.org 生产环境，单一稳定版本。

```
用户浏览器
    │
    ▼
miduo.org:443 (Host Nginx, Let's Encrypt 证书)
    │
    ▼
127.0.0.1:5500 (prdagent-gateway, Docker nginx)
    │
    ├── /api/* → api:8080 (prdagent-api 容器)
    └── /* → /usr/share/nginx/html (静态前端)
```

**操作步骤**：

```bash
# 1. 确保 CDS 没在运行（互斥）
./exec_bt.sh stop 2>/dev/null || true

# 2. 部署应用
./exec_dep.sh

# 3. 配置 Host Nginx（首次）
sudo cp deploy/nginx/public-nginx.example.conf /etc/nginx/sites-available/miduo.org.conf
# 编辑: 修改 server_name 为 miduo.org
sudo ln -sf /etc/nginx/sites-available/miduo.org.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. 申请 SSL 证书（首次）
sudo certbot --nginx -d miduo.org
```

**Host Nginx 配置 (`/etc/nginx/sites-available/miduo.org.conf`)**：

```nginx
# HTTP → HTTPS
server {
    listen 80;
    server_name miduo.org;
    return 301 https://$host$request_uri;
}

# HTTPS 主站
server {
    listen 443 ssl http2;
    server_name miduo.org;

    ssl_certificate     /etc/letsencrypt/live/miduo.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/miduo.org/privkey.pem;

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:5500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 60s;
    }
}
```

### 4.2 CDS 分支测试部署 (模式 B)

**适用场景**：测试环境，需要同时预览多个分支。

```
用户浏览器
    │
    ├── miduo.org:443 → Host Nginx → 127.0.0.1:5500 → CDS Worker Proxy → 分支容器
    └── miduo.org:9900 → CDS Dashboard (建议加 IP 白名单或子域名)
```

**操作步骤**：

```bash
# 1. 确保独立部署的 gateway 已停（互斥）
docker stop prdagent-gateway 2>/dev/null || true
# 注意：mongodb 和 redis 容器保持运行，CDS 分支容器共享使用

# 2. 配置 CDS 环境变量
export MONGODB_HOST=prdagent-mongodb    # 或宿主机 IP
export REDIS_HOST=prdagent-redis
export JWT_SECRET="your-jwt-secret"
# ... 其他 COS 等环境变量

# 3. 启动 CDS
./exec_bt.sh daemon

# 4. Host Nginx 配置同 4.1（:5500 被 CDS 接管，nginx 配置不用改）
```

### 4.3 模式 A ↔ 模式 B 切换

```bash
# 从独立部署 → CDS
docker stop prdagent-gateway
./exec_bt.sh daemon
# Host Nginx 不用动（还是转发到 :5500）

# 从 CDS → 独立部署
./exec_bt.sh stop
docker start prdagent-gateway
# 或直接 ./exec_dep.sh（会重建）
```

**关键点**：Host Nginx 配置完全不用改，因为它只知道 `:5500`，不关心谁在后面。

## 5. SSL 证书管理

### 5.1 证书位置

证书始终放在**宿主机**上，由 Host Nginx 管理，不进 Docker 容器。

```
/etc/letsencrypt/live/miduo.org/
├── fullchain.pem    # 完整证书链
├── privkey.pem      # 私钥
├── cert.pem         # 站点证书
└── chain.pem        # 中间证书
```

### 5.2 为什么不放在 Docker 内

1. **模式切换透明**：无论模式 A 还是模式 B，SSL 都由 Host Nginx 终止，Docker 内走 HTTP
2. **证书续期简单**：certbot 自动续期只需操作宿主机，不需要重建容器
3. **安全性**：证书不进镜像，不会被意外推送到仓库

### 5.3 certbot 自动续期

```bash
# 首次安装 + 申请
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d miduo.org

# 自动续期（certbot 安装时已注册 systemd timer）
sudo systemctl status certbot.timer

# 手动测试续期
sudo certbot renew --dry-run
```

## 6. 80/443 端口的处理方案

### 结论：保留占用，不屏蔽

80 和 443 端口**必须**由 Host Nginx 占用，原因：

| 方案 | 可行性 | 说明 |
|------|--------|------|
| ~~直接暴露 5500~~ | 不推荐 | 非标端口，用户需输入 `miduo.org:5500`，无法 SSL |
| ~~Docker 容器直接绑 443~~ | 不推荐 | 证书管理复杂，模式切换时需重建容器 |
| **Host Nginx 占 80/443** | **推荐** | SSL 终止 + 反代到 5500，模式切换透明 |

### 如果 80/443 被其他服务占用

```bash
# 检查谁在用
sudo ss -tlnp | grep ':80\|:443'

# 情况 1: 被 apache 占用 → 停掉或改端口
sudo systemctl stop apache2
sudo systemctl disable apache2

# 情况 2: 被 nginx 的 default 站点占用 → 禁用 default
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 情况 3: 有其他站点也需要 80/443 → 同一个 nginx 多 server block
# miduo.org 和其他站点共享 Host Nginx，各自配 server_name
```

## 7. Docker Network 注意事项

### 当前状态

- `docker-compose.yml` 声明 `prdagent-network: external: true`
- CDS 默认使用 `cds-network`（见 cds.config.example.json）

### 建议

如果 CDS 的分支容器需要访问 mongodb/redis（由 docker-compose.yml 管理），需要确保两者在同一网络：

```json
// cds.config.json — 使用和 docker-compose 相同的网络
{
  "dockerNetwork": "prdagent-network"
}
```

或者 CDS 分支容器通过宿主机 IP 连接 MongoDB/Redis（需要 docker-compose.yml 暴露端口）。

## 8. 决策清单

| # | 决策项 | 推荐方案 | 备选方案 |
|---|--------|---------|---------|
| D1 | 80/443 端口 | Host Nginx 占用，做 SSL 终止 | — |
| D2 | 5500 端口 | 模式 A/B 互斥使用 | 给 CDS 分配不同端口 (如 5501) |
| D3 | SSL 证书 | 宿主机 certbot + Host Nginx | Docker 内管理 (不推荐) |
| D4 | CDS Docker Network | 复用 prdagent-network | 独立 cds-network + host 端口转发 |
| D5 | 模式切换 | 手动停/启 (exec_bt.sh stop → exec_dep.sh) | 自动检测并切换 |
| D6 | 9900 Dashboard 公网暴露 | 加 IP 白名单 或 子域名 + BasicAuth | 仅内网访问 |
