# Skill: 开发环境安装、调试与还原

> 触发词：`装环境`、`环境搭建`、`setup env`、`dev env`、`还原环境`、`restore env`、`测试连接`、`test connectivity`、`dotnet restore`、`环境调试`

## 概述

一键完成开发环境的安装、配置、数据库连接测试和项目还原。适用于新机器初始化、CI 环境准备、排查环境问题。

## 核心原则

1. **环境变量驱动**：所有密码/密钥通过环境变量传入，绝不硬编码
2. **幂等执行**：重复运行不会破坏已有环境
3. **真实验证**：不靠假设，连真实数据库验证连通性
4. **最小依赖**：只装项目需要的，不装多余的

---

## 一、SDK 安装清单

| SDK | 版本要求 | 用途 | 安装方式 |
|-----|---------|------|---------|
| .NET SDK | 8.0.x | 后端 `prd-api` (C# 12, ASP.NET Core 8) | Microsoft 官方脚本 |
| Node.js | 22.x | 前端 `prd-admin`, `prd-desktop`, `prd-video` | nvm |
| pnpm | latest | 前端包管理器 | npm install -g |
| Rust | stable (edition 2021) | Tauri 桌面端 `prd-desktop/src-tauri` | rustup |
| tauri-cli | latest | Tauri 构建工具 | cargo install |
| Python 3 | 3.10+ | `prd-video/scripts` 字幕生成等 | 系统包管理器 |

### Linux 系统依赖 (Ubuntu/Debian)

Tauri 编译需要以下系统库：
```bash
sudo apt-get install -y \
  build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
```

---

## 二、一键安装脚本

```bash
# 完整一键安装（从零开始）
bash scripts/setup-dev-env.sh
```

### 手动分步安装

#### 2.1 .NET 8 SDK

```bash
# 下载并安装（推荐方式）
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0

# 配置 PATH（写入 ~/.bashrc 持久化）
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"

# 验证
dotnet --version  # 应输出 8.0.xxx
```

#### 2.2 Node.js 22 + pnpm

```bash
# 通过 nvm 安装
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22

# 安装 pnpm
npm install -g pnpm

# 验证
node -v   # v22.x.x
pnpm -v   # 10.x.x
```

#### 2.3 Rust + Tauri CLI

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cargo install tauri-cli

# 验证
rustc --version  # rustc 1.x.x
```

---

## 三、环境变量配置

### 3.1 必需环境变量

从 `.env.template` 复制并填入实际值：

```bash
cp .env.template .env
# 编辑 .env 填入实际值
```

**关键变量映射关系**（环境变量 → appsettings 配置路径）：

| 环境变量 | 映射到 | 默认值 | 说明 |
|---------|--------|--------|------|
| `MongoDB__ConnectionString` | `MongoDB:ConnectionString` | `mongodb://localhost:27017` | MongoDB 连接串 |
| `MongoDB__DatabaseName` | `MongoDB:DatabaseName` | `prdagent` | 数据库名 |
| `Redis__ConnectionString` | `Redis:ConnectionString` | `localhost:6379` | Redis 连接串 |
| `Jwt__Secret` | `Jwt:Secret` | (dev 有默认值) | JWT 签名密钥，>=32 字节 |
| `ASPNETCORE_ENVIRONMENT` | - | `Production` | 设为 `Development` 开启调试 |

**带密码的连接串格式**：

```bash
# MongoDB（密码中的特殊字符需 URL 编码）
MongoDB__ConnectionString="mongodb://root:<password>@<host>:27017/?authSource=admin"

# Redis
Redis__ConnectionString="<host>:6379,password=<password>"
```

### 3.2 可选环境变量

| 环境变量 | 说明 |
|---------|------|
| `LLM__ClaudeApiKey` | Claude API Key |
| `TENCENT_COS_*` | 腾讯云 COS 对象存储（6 个变量） |
| `ROOT_ACCESS_USERNAME` / `ROOT_ACCESS_PASSWORD` | 超级管理员账号 |

---

## 四、项目还原（Restore）

```bash
# 后端 NuGet 包还原
cd prd-api && dotnet restore PrdAgent.sln

# 验证编译
dotnet build --no-restore 2>&1 | grep -E "error CS|Build succeeded"

# 前端依赖安装
cd ../prd-admin && pnpm install
cd ../prd-desktop && pnpm install
cd ../prd-video && pnpm install  # 如果存在
```

---

## 五、数据库连接测试

### 5.1 快速连通性测试

创建临时测试项目验证连接：

```bash
# 准备环境变量（从 .env 加载或手动 export）
export MONGODB_HOST=<host>
export MONGODB_PASSWORD='<password>'
export REDIS_HOST=<host>
export REDIS_PASSWORD='<password>'

# 运行连通性测试脚本
dotnet run --project /tmp/dbtest
```

测试项目代码参考 `scripts/test-connectivity.csx`。

### 5.2 通过 dotnet test 验证

```bash
# 设置环境变量后运行集成测试
export MongoDB__ConnectionString="mongodb://root:<password>@<host>:27017/?authSource=admin"
export MongoDB__DatabaseName="prdagent_test"  # 建议用独立测试库
export Redis__ConnectionString="<host>:6379,password=<password>"
export Jwt__Secret="test-secret-key-32bytes-minimum!!"

cd prd-api
dotnet test --no-build --filter "Category=Integration" 2>&1
```

### 5.3 启动 API 服务验证

```bash
export ASPNETCORE_ENVIRONMENT=Development
export MongoDB__ConnectionString="mongodb://root:<password>@<host>:27017/?authSource=admin"
export Redis__ConnectionString="<host>:6379,password=<password>"
export Jwt__Secret="dev-only-change-me-32bytes-minimum!!"

cd prd-api
dotnet run --project src/PrdAgent.Api -- --urls "http://localhost:5000"

# 另一个终端验证
curl http://localhost:5000/swagger/index.html -o /dev/null -w "HTTP %{http_code}\n"
```

---

## 六、常见问题排查

| 问题 | 排查方式 |
|------|---------|
| `dotnet: command not found` | 检查 `DOTNET_ROOT` 和 `PATH` 是否配置 |
| MongoDB 连接超时 | 检查防火墙 27017 端口、密码中特殊字符是否 URL 编码 |
| Redis 连接失败 | 检查 6379 端口、`requirepass` 配置是否匹配 |
| NuGet 还原失败 | 检查网络，或使用 `dotnet nuget locals all --clear` 清除缓存 |
| Tauri 编译失败 | 检查系统库是否安装完整（webkit2gtk 等） |
| `error CS*` 编译错误 | 运行 `dotnet build --no-restore 2>&1 | grep "error CS"` 定位 |

---

## 七、Docker 一键启动（替代方案）

如果不想安装 SDK，可以直接用 Docker：

```bash
# 本地构建 + 启动全部服务（API + MongoDB + Redis + Nginx）
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build

# 开发模式（暴露端口，热加载）
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

---

## 八、AI 执行此技能时的操作流程

当 AI 被要求搭建/调试环境时，按以下顺序执行：

1. **检测已安装的 SDK**：`dotnet --version`, `node -v`, `rustc --version`
2. **安装缺失的 SDK**：优先使用官方安装脚本
3. **配置环境变量**：从用户提供的值设置，绝不在代码中暴露
4. **执行 restore**：`dotnet restore` + `pnpm install`
5. **编译验证**：`dotnet build` 确认 0 error
6. **连通性测试**：创建临时项目测试 MongoDB + Redis 连接
7. **报告结果**：列出各组件版本和连接状态
