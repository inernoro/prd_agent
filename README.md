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

# Docker 部署（生产：禁止本地构建）
# 生产环境请先准备好已构建并推送到镜像仓库的镜像，然后通过环境变量指定镜像（tag 或 digest）：
# - PRD_AGENT_WEB_IMAGE=ghcr.io/<org>/<repo>/prdagent-web:vX.Y.Z
# - PRD_AGENT_API_IMAGE=ghcr.io/<org>/<repo>/prdagent-server:vX.Y.Z
#
# 推荐用 digest 固定版本，避免 tag 漂移：
# - PRD_AGENT_WEB_IMAGE=ghcr.io/<org>/<repo>/prdagent-web@sha256:...
# - PRD_AGENT_API_IMAGE=ghcr.io/<org>/<repo>/prdagent-server@sha256:...
#
# 如仓库为私有，还需要先登录：
# docker login ghcr.io
#
# 启动：
docker compose up -d
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

## 许可证

MIT

