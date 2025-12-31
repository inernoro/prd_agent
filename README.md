# PRD Agent

专精于 PRD 理解的智能 Agent，用 AI 作为产品经理的"嘴替"，实现"文档即共识"的目标。

## 项目结构

```
prd_agent/
├── doc/                          # 设计文档
├── prd-api/                      # 后端服务 (.NET 8)
│   ├── src/
│   │   ├── PrdAgent.Api/         # API 层
│   │   ├── PrdAgent.Core/        # 核心业务层
│   │   └── PrdAgent.Infrastructure/  # 基础设施层
│   └── tests/
├── prd-desktop/                  # 桌面客户端 (Tauri + React)
│   ├── src-tauri/                # Rust 后端
│   └── src/                      # React 前端
├── prd-admin/                    # Web 管理后台 (React + Ant Design)
│   └── src/
├── scripts/                      # 构建脚本
└── docker-compose.yml            # Docker 配置
```

## 技术栈

| 端 | 技术栈 |
|---|---|
| 后端 | .NET 8 + ASP.NET Core + MongoDB.Driver + Redis + Serilog |
| 桌面客户端 | Tauri 2.0 + Rust + React 18 + TypeScript + Zustand + Tailwind CSS |
| 管理后台 | React 18 + TypeScript + Vite + Ant Design 5 + ECharts |

## 快速开始

### 环境要求

- Node.js 18+
- pnpm 8+
- .NET 8 SDK
- Rust 1.70+
- Docker & Docker Compose

### 开发环境

1. **克隆仓库**
```bash
git clone <repository-url>
cd prd_agent
```

2. **配置环境变量**

配置 Claude API Key（必需）：
```bash
# Windows PowerShell
$env:LLM__ClaudeApiKey="your-claude-api-key-here"

# Linux/macOS
export LLM__ClaudeApiKey="your-claude-api-key-here"

# 或在 appsettings.json 中配置（不推荐，敏感信息应使用环境变量）
# {
#   "LLM": {
#     "ClaudeApiKey": "your-claude-api-key-here",
#     "Model": "claude-3-5-sonnet-20241022"
#   }
# }
```

> 注意：Claude API Key 可以从 [Anthropic Console](https://console.anthropic.com/) 获取

3. **启动开发环境**
```powershell
.\scripts\dev.ps1
```

或分别启动：
```powershell
# 启动 Docker 服务
docker-compose up mongodb redis -d

# 启动后端服务
cd prd-api/src/PrdAgent.Api
dotnet watch run

# 启动桌面客户端
cd prd-desktop
pnpm install
pnpm tauri dev

# 启动管理后台
cd prd-admin
pnpm install
pnpm dev
```

### 构建

```powershell
# 构建后端
.\scripts\build-server.ps1

# 构建桌面客户端
.\scripts\build-desktop.ps1 -Platform windows

# 生产/测试部署（只维护 main/latest）
#
# 1) GitHub Actions 只维护一个版本：latest
#    - 后端镜像：main 构建完成后推送到 GHCR 的 prdagent-server:latest
#    - 管理后台静态：自动发布到 GitHub Pages（稳定下载地址）
#      - https://inernoro.github.io/prd_agent/prd-admin-dist-latest.zip
#      - https://inernoro.github.io/prd_agent/admin/ （解压后的静态目录）
#
# 2) 线上服务器准备好 docker-compose（以及 curl/unzip）
#
# 3) 一键部署命令（不 build）
#      ./deploy.sh
#
#    如需覆盖静态下载地址（例如你自建 Web 站点/CDN）：
#      DIST_URL="https://your-cdn.example.com/prd-admin-dist-latest.zip" ./deploy.sh
#
#    - 静态会解压到 deploy/web/dist
#    - nginx 容器挂载该目录作为站点根目录
#    - /api/ 将反代到 api:8080（优先级最高，支持 SSE）
#    - deploy.sh 会先 `docker-compose pull api` 再 `docker-compose up -d --force-recreate`，避免复用旧的 :latest 镜像
```

## 版本号与桌面端打包产物命名（CI/本地）

桌面端（Tauri）打包产物文件名会包含应用版本号；该版本号来自：
- `prd-desktop/src-tauri/tauri.conf.json` 的 `"version"`
- `prd-desktop/src-tauri/Cargo.toml` 的 `[package].version`
- `prd-desktop/package.json` 的 `"version"`

为避免 CI 使用旧版本号导致产物仍然是 `*_1.0.0_*`，仓库提供了同步脚本：

```bash
# 显式指定版本（支持 v 前缀）
./quick.sh version v1.2.4

# 或者不传参：自动从 git tag 推断（git describe --tags --abbrev=0）
./quick.sh version
```

在 GitHub Actions 中，建议在 `tauri build` 之前执行（tag 触发时 `GITHUB_REF_NAME` 通常就是 v1.2.4）：

```bash
bash scripts/sync-desktop-version.sh "${GITHUB_REF_NAME}"
```

## API 端点

| 端点 | 描述 |
|---|---|
| `POST /api/v1/auth/register` | 用户注册 |
| `POST /api/v1/auth/login` | 用户登录 |
| `POST /api/v1/documents` | 上传PRD文档 |
| `GET /api/v1/sessions/{id}` | 获取会话 |
| `PUT /api/v1/sessions/{id}/role` | 切换角色 |
| `POST /api/v1/sessions/{id}/messages` | 发送消息 (SSE) |
| `POST /api/v1/sessions/{id}/guide/start` | 启动引导讲解 |
| `POST /api/v1/groups` | 创建群组 |
| `POST /api/v1/groups/join` | 加入群组 |
| `GET /api/v1/admin/stats/overview` | 管理后台统计 |

## 用户角色

- **PM** - 产品经理（可创建群组、上传PRD）
- **DEV** - 开发（技术视角）
- **QA** - 测试（验证视角）
- **ADMIN** - 超管（Web后台管理）

## 核心功能

1. **文档理解** - 上传 Markdown PRD，AI 自动解析和理解
2. **角色适配** - 根据用户角色提供不同视角的解读
3. **智能问答** - 基于 PRD 内容的精准问答
4. **引导讲解** - 分步骤系统讲解 PRD
5. **群组协作** - 团队共享 PRD 解读会话
6. **内容缺失检测** - AI 识别 PRD 中的遗漏点

## 数据字典（所有持久化清单）

任何会写入/可恢复的状态（**MongoDB 集合、Redis/内存缓存 key、COS 对象 key、Web/桌面端本地存储、桌面端落盘文件**）都必须在数据字典中维护：

- `doc/7.data-dictionary.md`

## 许可证

MIT

