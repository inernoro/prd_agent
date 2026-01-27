# PRD Publish

轻量级版本发布管理系统，支持多项目部署。

## Quick Start (3 步启动)

### Linux / macOS

```bash
pnpm install                          # 1. 安装依赖
cp .env.example .env && nano .env     # 2. 配置密码
pnpm start                            # 3. 启动服务
```

### Windows (PowerShell)

```powershell
pnpm install                          # 1. 安装依赖
copy .env.example .env; notepad .env  # 2. 配置密码
pnpm start                            # 3. 启动服务
```

打开浏览器访问 `http://localhost:3939`

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| 认证 | JWT (jsonwebtoken) |
| 前端 | 原生 JS + CSS (零框架) |
| 存储 | JSON 文件 (零数据库) |
| 部署 | Shell / PowerShell 脚本 |

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ 项目选择器   │  │  版本列表   │  │     部署控制台      │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
└─────────┼────────────────┼───────────────────┼──────────────┘
          │                │                   │
          ▼                ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                     Express Server                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ /projects│  │ /commits │  │ /deploy  │  │ /history   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
└───────┼─────────────┼─────────────┼──────────────┼──────────┘
        │             │             │              │
        ▼             ▼             ▼              ▼
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│ projects  │  │    git    │  │  deploy   │  │  history  │
│  .json    │  │   repo    │  │  script   │  │   .json   │
└───────────┘  └───────────┘  └───────────┘  └───────────┘
```

## 核心原理

### 1. 版本获取

```bash
git log --oneline -n 50    # 从目标仓库读取最近 50 条提交
```

### 2. 部署流程

```
用户点击发布 → 校验 commit → git checkout → 执行脚本 → 记录历史
                  │              │              │
                  ▼              ▼              ▼
            验证 hash 格式   切换到目标版本   运行用户定义的部署脚本
```

### 3. 脚本接口

部署脚本接收以下参数和环境变量：

**Linux / macOS (Bash)**
```bash
# 位置参数
$1 = commit_hash    # 完整 hash (40位)
$2 = short_hash     # 短 hash (7位)
$3 = branch         # 分支名
$4 = project_id     # 项目 ID

# 环境变量
PROJECT_ID          # 项目 ID
PROJECT_NAME        # 项目名称
REPO_PATH           # 仓库路径
```

**Windows (PowerShell)**
```powershell
# 位置参数
$args[0] = commit_hash    # 完整 hash (40位)
$args[1] = short_hash     # 短 hash (7位)
$args[2] = branch         # 分支名
$args[3] = project_id     # 项目 ID

# 环境变量
$env:PROJECT_ID           # 项目 ID
$env:PROJECT_NAME         # 项目名称
$env:REPO_PATH            # 仓库路径
```

## 多项目配置

### 方式一：Web 界面添加

点击项目选择器 → 添加项目 → 填写配置

### 方式二：直接编辑 JSON

```bash
nano data/projects.json
```

**Linux / macOS:**
```json
{
  "projects": [
    {
      "id": "frontend",
      "name": "前端项目",
      "repoPath": "/var/www/frontend",
      "script": "./scripts/deploy-frontend.sh",
      "branch": "main"
    }
  ]
}
```

**Windows:**
```json
{
  "projects": [
    {
      "id": "frontend",
      "name": "前端项目",
      "repoPath": "C:\\Projects\\frontend",
      "script": "./scripts/deploy-frontend.ps1",
      "branch": "main"
    }
  ]
}
```

## 编写部署脚本

### Linux / macOS

```bash
# 复制模板
cp scripts/_template.sh scripts/deploy-myproject.sh
chmod +x scripts/deploy-myproject.sh
```

示例脚本 (`deploy-myproject.sh`)：

```bash
#!/bin/bash
set -e

echo "=== 部署 $PROJECT_NAME ==="
echo "版本: $2"

cd "$REPO_PATH"

pnpm install --frozen-lockfile
pnpm build
pm2 restart $PROJECT_ID || pm2 start ecosystem.config.js

echo "=== 部署完成 ==="
```

### Windows

```powershell
# 复制模板
copy scripts\_template.ps1 scripts\deploy-myproject.ps1
```

示例脚本 (`deploy-myproject.ps1`)：

```powershell
$ErrorActionPreference = "Stop"

Write-Host "=== 部署 $env:PROJECT_NAME ==="
Write-Host "版本: $($args[1])"

Set-Location $env:REPO_PATH

pnpm install --frozen-lockfile
pnpm build

# 重启服务 (根据实际情况修改)
pm2 restart $env:PROJECT_ID

Write-Host "=== 部署完成 ==="
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PUBLISH_USERNAME` | admin | 登录用户名 |
| `PUBLISH_PASSWORD` | (必填) | 登录密码 |
| `PUBLISH_JWT_SECRET` | (必填) | JWT 签名密钥 |
| `PUBLISH_PORT` | 3939 | 服务端口 |
| `PUBLISH_REPO_PATH` | 当前目录 | 默认仓库路径 |
| `PUBLISH_EXEC_SCRIPT` | ./scripts/deploy-example.sh | 默认部署脚本 |

## 目录结构

```
prd-publish/
├── data/               # 数据存储
│   ├── projects.json   # 项目配置
│   └── history.json    # 部署历史
├── scripts/            # 部署脚本目录
│   ├── _template.sh    # Bash 模板 (Linux/macOS)
│   ├── _template.ps1   # PowerShell 模板 (Windows)
│   └── deploy-*.*      # 用户脚本
├── public/             # 前端静态文件
├── src/
│   ├── routes/         # API 路由
│   ├── services/       # 业务逻辑
│   └── middleware/     # 中间件
└── tests/              # 测试文件
```

## 开发

```bash
# 开发模式 (热重载)
pnpm dev

# 运行测试
pnpm test

# 代码检查
pnpm lint
```

## License

MIT
