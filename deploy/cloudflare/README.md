# Cloudflare 部署指南

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                     Cloudflare 网络                       │
│                                                          │
│  ┌─────────────────────┐    ┌─────────────────────────┐  │
│  │  Cloudflare Pages   │    │   Cloudflare Tunnel     │  │
│  │  (前端静态站点)      │    │   (安全隧道)            │  │
│  │                     │    │                         │  │
│  │  prd-admin/dist     │    │  api.yourdomain.com     │  │
│  │  app.yourdomain.com │    │         │               │  │
│  └─────────┬───────────┘    └─────────┼───────────────┘  │
│            │                          │                  │
└────────────┼──────────────────────────┼──────────────────┘
             │                          │
     用户浏览器访问                cloudflared 隧道
             │                          │
             │         ┌────────────────┼──────────────┐
             │         │  你的服务器 (VPS/云主机)       │
             │         │                │              │
             │         │  ┌─────────────▼────────┐     │
             │         │  │  .NET 8 API (:8080)  │     │
             │         │  └──────────┬───────────┘     │
             │         │             │                 │
             │         │  ┌──────────▼───┐  ┌──────┐  │
             │         │  │ MongoDB:27017│  │Redis │  │
             │         │  └──────────────┘  └──────┘  │
             │         └───────────────────────────────┘
             │
             │  API 请求走 /api/* → Pages Functions 代理
             │  或直连后端 (VITE_API_BASE_URL)
             ▼
```

## 部署方案

### 方案 A: Cloudflare Pages + Pages Functions 代理 (推荐)

前端部署到 Cloudflare Pages，API 请求通过 Pages Functions 代理到后端。

**优点**: 同源部署，无 CORS 问题，前端免费全球 CDN
**适用**: 后端已有公网地址或通过 Cloudflare Tunnel 暴露

### 方案 B: Cloudflare Pages + 直连后端

前端部署到 Cloudflare Pages，通过 `VITE_API_BASE_URL` 直连后端。

**优点**: 简单，不依赖 Pages Functions
**缺点**: 需要配置 CORS

### 方案 C: 全 Cloudflare (Pages + Tunnel)

前端用 Pages，后端通过 Cloudflare Tunnel 安全暴露，无需公网 IP。

**优点**: 最安全，服务器无需开放端口
**适用**: 对安全性要求高的场景

---

## 快速开始

### 第一步: 准备 Cloudflare 账号

1. 注册 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
2. 将域名添加到 Cloudflare (或使用 `*.pages.dev` 子域名)
3. 创建 API Token:
   - 进入 [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
   - 点击 "Create Token"
   - 使用 "Edit Cloudflare Workers" 模板
   - 添加权限: `Cloudflare Pages: Edit`
   - 记录 Token 和 Account ID

### 第二步: 部署前端 (Cloudflare Pages)

#### 方式一: GitHub Actions 自动部署 (推荐)

1. 在 GitHub 仓库设置 Secrets:
   - `CLOUDFLARE_API_TOKEN`: 上一步创建的 API Token
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare 账号 ID (Dashboard 首页右下角)

2. 在 Cloudflare Dashboard 创建 Pages 项目:
   - 进入 Workers & Pages → Create → Pages
   - 选择 "Direct Upload" (由 GitHub Actions 上传)
   - 项目名设为 `prdagent`

3. Push 代码到 `main` 分支，自动触发部署

4. 配置环境变量 (Cloudflare Dashboard → Pages → Settings → Environment variables):
   - `API_BACKEND_URL`: 后端地址 (如 `https://api.yourdomain.com`)

#### 方式二: 本地手动部署

```bash
# 安装 wrangler
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 构建前端
cd prd-admin
pnpm install
pnpm build

# 复制 Functions 到构建产物
cp -r ../deploy/cloudflare/functions/ dist/functions/

# 部署
npx wrangler pages deploy dist --project-name=prdagent
```

#### 方式三: Cloudflare Dashboard 直连 GitHub

1. 进入 Workers & Pages → Create → Pages → Connect to Git
2. 选择 GitHub 仓库
3. 配置构建设置:
   - Framework preset: `None`
   - Build command: `cd prd-admin && npm install -g pnpm && pnpm install && pnpm build`
   - Build output directory: `prd-admin/dist`
   - Root directory: `/` (仓库根目录)
4. 环境变量:
   - `NODE_VERSION`: `20`
   - `VITE_API_BASE_URL`: `` (空，使用 Pages Functions 代理)

### 第三步: 部署后端

后端 (.NET 8 + MongoDB + Redis) 需要运行在服务器上。有两种暴露方式:

#### 方式一: Cloudflare Tunnel (推荐，无需公网 IP)

```bash
# 1. 安装 cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

# 2. 登录
cloudflared tunnel login

# 3. 创建隧道
cloudflared tunnel create prdagent-api
# 记录返回的 Tunnel ID

# 4. 创建 DNS 记录
cloudflared tunnel route dns prdagent-api api.yourdomain.com

# 5. 启动隧道 (直接运行)
cloudflared tunnel --config deploy/cloudflare/tunnel-config.yml run prdagent-api

# 或使用 Docker Compose 集成
docker compose -f docker-compose.yml -f deploy/cloudflare/docker-compose.tunnel.yml up -d
```

使用 Docker Compose 集成时，设置环境变量:
```bash
# .env 文件
CLOUDFLARE_TUNNEL_TOKEN=eyJh...  # 从 Cloudflare Dashboard → Zero Trust → Tunnels 获取
```

#### 方式二: 传统公网暴露

如果服务器已有公网 IP 和域名:
1. 将域名 DNS 接入 Cloudflare (利用 CDN 和 DDoS 防护)
2. 在 Cloudflare DNS 中添加 A 记录指向服务器 IP
3. 开启 "Proxy" 状态 (橙色云朵)
4. 在 Cloudflare Dashboard → Pages → Settings 中设置 `API_BACKEND_URL`

### 第四步: 配置自定义域名 (可选)

1. Cloudflare Dashboard → Pages → prdagent → Custom domains
2. 添加域名 (如 `app.yourdomain.com`)
3. Cloudflare 会自动配置 DNS 和 SSL

---

## 环境变量清单

### Cloudflare Pages 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `API_BACKEND_URL` | 是 (方案 A) | 后端 API 地址，Pages Functions 代理使用 |
| `VITE_API_BASE_URL` | 否 | 构建时注入，空 = 同源代理，非空 = 直连后端 |
| `NODE_VERSION` | 否 | Node.js 版本 (推荐 20) |

### GitHub Actions Secrets

| Secret | 必需 | 说明 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | 是 | Cloudflare API Token (需 Pages 编辑权限) |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare Account ID |

### Cloudflare Tunnel 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `CLOUDFLARE_TUNNEL_TOKEN` | 是 | Tunnel 运行令牌 |

---

## 免费额度说明

| 服务 | 免费额度 | 超出价格 |
|------|----------|----------|
| **Cloudflare Pages** | 无限站点，500 次构建/月 | $5/月起 |
| **Pages Functions** | 10 万次请求/天 | $0.50/百万次 |
| **Cloudflare Tunnel** | 免费 (Zero Trust Free Plan) | — |
| **CDN 流量** | 无限 | — |
| **SSL 证书** | 自动免费 | — |
| **DDoS 防护** | 无限 (基础) | — |

> 对于中小规模应用，Cloudflare 免费套餐完全够用。

---

## 常见问题

### Q: 后端 .NET 8 能否直接运行在 Cloudflare Workers 上?

**不能**。Cloudflare Workers 仅支持 JavaScript/TypeScript/Rust/Python/C。
.NET 后端需要运行在独立服务器上，通过 Cloudflare Tunnel 或公网暴露。

### Q: SSE 流式响应在 Cloudflare 上能正常工作吗?

**能**。Pages Functions 代理已配置 `Cache-Control: no-cache` 和 `X-Accel-Buffering: no`。
Cloudflare Tunnel 也支持长连接 (配置了 `keepAliveTimeout: 3600s`)。

### Q: Pages Functions 代理 vs 直连后端，哪个更好?

- **Pages Functions 代理**: 同源，无 CORS 问题，但有 10 万/天请求限制和冷启动延迟
- **直连后端**: 无请求限制，需配置 CORS，适合高流量场景

### Q: 如何从 Docker Compose (Nginx) 迁移到 Cloudflare?

1. 前端: 停用 Nginx 容器，改用 Cloudflare Pages
2. 后端: 保持 docker-compose.yml 中的 api/mongodb/redis 不变
3. 网络: 用 Cloudflare Tunnel 替代 Nginx 反向代理
4. SSL: 由 Cloudflare 自动管理，无需手动维护

---

## 文件清单

```
deploy/cloudflare/
├── README.md                    # 本文档
├── wrangler.toml                # Cloudflare Pages 配置
├── tunnel-config.yml            # Cloudflare Tunnel 配置模板
├── docker-compose.tunnel.yml    # Tunnel Docker Compose 扩展
└── functions/
    └── api/
        └── [[path]].ts          # API 反向代理 Pages Function

prd-admin/public/
├── _headers                     # Cloudflare Pages 自定义 HTTP 头
└── _redirects                   # SPA 路由回退规则

.github/workflows/
└── cloudflare-pages-deploy.yml  # GitHub Actions 自动部署
```
