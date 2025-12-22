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

# 生产部署（推荐：Release 静态 + Docker 只跑 nginx/api/db）
#
# 1) 打 tag（例如 v1.2.3）后，GitHub Actions 会：
#    - 构建 prd-admin/dist 并打包成 Release 资产：prd-admin-dist-<tag>.zip
#    - 构建并推送后端镜像到 GHCR：prdagent-server:<tag> 以及 :latest
#
# 2) 线上服务器准备好 docker-compose（以及 curl/unzip）
#
# 3) 线上部署命令（下载静态到本地，再 docker-compose up -d）：
#    Linux/macOS 示例：
#      export PRD_AGENT_API_IMAGE="ghcr.io/inernoro/prd_agent/prdagent-server:v1.2.3"
#      # 通常不需要设置 REPO：deploy.sh 会尝试从 git remote 自动推断
#      ./deploy.sh v1.2.3
#
#    若服务器上不是 git 仓库目录（无法推断），再显式传 REPO：
#      ./deploy.sh v1.2.3 inernoro/prd_agent
#
#    - 静态会解压到 deploy/web/dist
#    - nginx 容器挂载该目录作为站点根目录
#    - /api/ 将反代到 api:8080（优先级最高，支持 SSE）
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

