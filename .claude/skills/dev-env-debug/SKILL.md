# Skill: 开发环境安装、调试与还原

> 触发词：`装环境`、`环境搭建`、`setup env`、`dev env`、`还原环境`、`restore env`、`测试连接`、`test connectivity`、`dotnet restore`、`环境调试`

## 概述

一键完成开发环境的安装、配置、数据库连接测试和项目还原。自动检测运行模式（本地 CLI / 云端 Web 沙箱），对已知平台 Bug 自动绕过。

## 核心原则

1. **环境变量驱动**：所有密码/密钥通过环境变量传入，绝不硬编码到代码
2. **幂等执行**：重复运行不会破坏已有环境
3. **真实验证**：不靠假设，连真实数据库验证连通性
4. **双模自适应**：自动区分本地 CLI 与 Web 沙箱，选择对应安装策略

---

## 零、两种运行模式（重要前置知识）

| 维度 | 本地 CLI 模式 | Claude Code Web 沙箱模式 |
|------|-------------|------------------------|
| 运行环境 | 用户本机终端 | Anthropic 托管 Ubuntu 容器 |
| .NET SDK | 用户自行安装，完全可控 | 需通过 `dotnet-install.sh` 安装 |
| `dotnet restore` | 正常工作 | **需启动代理中继**（.NET HttpClient 代理认证 Bug） |
| `apt-get` | 正常工作 | 受限（部分源不可达） |
| 网络访问 | 无限制 | JWT 认证代理，存在已知兼容性问题 |
| 外部数据库 | 正常连接 | 部分端口/IP 可能受限 |

### 如何判断当前模式

```bash
# 检查是否在 Web 沙箱中
if [ -n "$HTTPS_PROXY" ] && echo "$HTTPS_PROXY" | grep -q "container_"; then
  echo "Web sandbox mode"
else
  echo "Local CLI mode"
fi
```

---

## 一、SDK 安装清单

| SDK | 版本要求 | 用途 | 安装方式 |
|-----|---------|------|---------|
| .NET SDK | 8.0.x | 后端 `prd-api` (C# 12, ASP.NET Core 8) | `dotnet-install.sh`（推荐，本地/Web 通用） |
| Node.js | 22.x | 前端 `prd-admin`, `prd-desktop`, `prd-video` | nvm（Web 沙箱已预装） |
| pnpm | latest | 前端包管理器 | npm install -g（Web 沙箱已预装） |
| Rust | stable (edition 2021) | Tauri 桌面端 `prd-desktop/src-tauri` | rustup（Web 沙箱已预装） |
| tauri-cli | latest | Tauri 构建工具 | cargo install |
| Python 3 | 3.10+ | `prd-video/scripts` 字幕生成 + NuGet 代理中继 | 系统包管理器 |

### Linux 系统依赖 (Ubuntu/Debian, 仅本地模式需要)

```bash
sudo apt-get install -y \
  build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
```

---

## 二、一键安装

### 方式 A：完整一键脚本（本地推荐）

```bash
bash scripts/setup-dev-env.sh
```

### 方式 B：SessionStart Hook（Web 沙箱自动触发）

```bash
# 每次 Web 会话开始时自动执行
bash .claude/hooks/session-start.sh
```

Hook 自动完成：
1. 检测环境（Web/本地）
2. 安装 .NET 8 SDK（如缺失）
3. 启动 NuGet 代理中继（仅 Web 沙箱）
4. 执行 `dotnet restore`

### 方式 C：手动分步安装

#### .NET 8 SDK（本地/Web 通用）

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
dotnet --version  # 8.0.xxx
```

#### Node.js 22 + pnpm（本地安装，Web 已预装）

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22 && nvm alias default 22
npm install -g pnpm
```

#### Rust + Tauri CLI（本地安装，Web 已预装）

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cargo install tauri-cli
```

---

## 三、dotnet restore 在 Web 沙箱中的特殊处理

### 问题根源

Claude Code Web 的出口代理使用 JWT Token 认证（`http://container_id:jwt_token@proxy:port`）。
.NET HttpClient 在 Linux 上存在已知 Bug（[dotnet/runtime#114066](https://github.com/dotnet/runtime/issues/114066)），
无法正确发送 `Proxy-Authorization` 头，导致 NuGet restore 返回 `401 Unauthorized`。

### 解决方案：NuGet 代理中继

项目内置了 Python 代理中继脚本 `scripts/nuget-proxy-relay.py`，原理：
1. 在本地 `127.0.0.1:18080` 启动 HTTP 代理
2. 拦截 dotnet 的请求，注入正确的 `Proxy-Authorization` 头
3. 转发到上游 JWT 代理

```bash
# 启动代理中继
python3 scripts/nuget-proxy-relay.py &
RELAY_PID=$!

# 通过中继执行 restore（关键：覆盖 HTTPS_PROXY 指向本地）
HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 \
  dotnet restore PrdAgent.sln

# 完成后停止中继
kill $RELAY_PID
```

### 验证状态

此方案已在 Claude Code Web 沙箱中实际验证通过：
- `dotnet restore PrdAgent.sln` -- 4 个项目全部成功 restore
- `dotnet build --no-restore` -- Build succeeded, 0 error

---

## 四、环境变量配置

### 必需环境变量

从 `.env.template` 复制：`cp .env.template .env`

| 环境变量 | 映射到 | 默认值 | 说明 |
|---------|--------|--------|------|
| `MongoDB__ConnectionString` | `MongoDB:ConnectionString` | `mongodb://localhost:27017` | MongoDB 连接串 |
| `MongoDB__DatabaseName` | `MongoDB:DatabaseName` | `prdagent` | 数据库名 |
| `Redis__ConnectionString` | `Redis:ConnectionString` | `localhost:6379` | Redis 连接串 |
| `Jwt__Secret` | `Jwt:Secret` | (dev 有默认值) | JWT 签名密钥，>=32 字节 |
| `ASPNETCORE_ENVIRONMENT` | - | `Production` | 设为 `Development` 开启调试 |

**带密码的连接串格式**（密码中特殊字符需 URL 编码）：

```bash
# MongoDB
MongoDB__ConnectionString="mongodb://root:<url-encoded-password>@<host>:27017/?authSource=admin"
# Redis
Redis__ConnectionString="<host>:6379,password=<password>"
```

### 可选环境变量

| 环境变量 | 说明 |
|---------|------|
| `LLM__ClaudeApiKey` | Claude API Key |
| `TENCENT_COS_*` | 腾讯云 COS 对象存储（6 个变量） |
| `ROOT_ACCESS_USERNAME` / `ROOT_ACCESS_PASSWORD` | 超级管理员账号 |

---

## 五、项目还原（Restore）

```bash
# 后端 NuGet 包还原
cd prd-api && dotnet restore PrdAgent.sln

# 验证编译（CLAUDE.md 强制规则：0 error 才算通过）
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30

# 前端依赖安装
cd prd-admin && pnpm install
cd prd-desktop && pnpm install
cd prd-video && pnpm install
```

---

## 六、数据库连接测试

### 6.1 快速连通性测试

```bash
# 设置环境变量（绝不硬编码密码）
export MONGODB_HOST=<host>
export MONGODB_PASSWORD='<password>'
export REDIS_HOST=<host>
export REDIS_PASSWORD='<password>'
```

创建临时 .NET 项目测试：

```csharp
// 关键代码：MongoDB
var mongoCs = $"mongodb://root:{Uri.EscapeDataString(password)}@{host}:27017/?authSource=admin";
var client = new MongoClient(mongoCs);
var db = client.GetDatabase("prdagent");
var cols = db.ListCollectionNames().ToList();
// 成功：返回集合列表；空库：返回 0 个集合（正常）

// 关键代码：Redis
var redis = ConnectionMultiplexer.Connect($"{host}:6379,password={password}");
var pong = redis.GetDatabase().Ping();
// 成功：返回 PONG 延迟
```

### 6.2 通过 API 服务验证

```bash
export ASPNETCORE_ENVIRONMENT=Development
export Jwt__Secret="dev-only-change-me-32bytes-minimum!!"
cd prd-api && dotnet run --project src/PrdAgent.Api -- --urls "http://localhost:5000"

# 另一终端
curl http://localhost:5000/swagger/index.html -o /dev/null -w "HTTP %{http_code}\n"
# 应返回 HTTP 200
```

---

## 七、常见问题排查

| 问题 | 模式 | 排查方式 |
|------|------|---------|
| `dotnet: command not found` | 两者 | 检查 `DOTNET_ROOT` 和 `PATH`，运行 `source ~/.bashrc` |
| NuGet `401 Unauthorized` | Web | 启动 `nuget-proxy-relay.py` 后重试 |
| NuGet `403 Access Denied` | Web | .NET CDN 被代理拦截，用 `dotnet-install.sh` 替代 `apt install` |
| `apt-get update` 失败 | Web | 沙箱网络限制，改用 curl 直接下载 |
| MongoDB 连接超时 | Web | 沙箱可能不允许访问外部 IP，改用 Docker 本地 MongoDB |
| MongoDB 连接超时 | 本地 | 检查防火墙 27017、密码特殊字符 URL 编码 |
| Redis 连接失败 | 两者 | 检查 6379 端口、`requirepass` 配置 |
| Tauri 编译失败 | 本地 | 检查 webkit2gtk 等系统库是否安装 |

---

## 八、Docker 一键启动（替代方案）

不安装 SDK，直接用 Docker：

```bash
# 本地构建全栈（API + MongoDB + Redis + Nginx）
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build

# 开发模式
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

---

## 九、AI 执行此技能时的操作流程

当 AI 被要求搭建/调试环境时，按以下顺序执行：

### 步骤 1：环境检测
```bash
dotnet --version 2>/dev/null || echo "MISSING"
node -v 2>/dev/null || echo "MISSING"
rustc --version 2>/dev/null || echo "MISSING"
# 检测是否在 Web 沙箱
echo $HTTPS_PROXY | grep -q "container_" && echo "WEB_SANDBOX" || echo "LOCAL"
```

### 步骤 2：安装缺失 SDK
- .NET: `curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0`
- Node: `nvm install 22`（如缺失）
- Rust: `rustup install stable`（如缺失）

### 步骤 3：Web 沙箱专属 - 启动 NuGet 代理中继
```bash
python3 scripts/nuget-proxy-relay.py &
```

### 步骤 4：dotnet restore
```bash
# Web 沙箱
HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 dotnet restore PrdAgent.sln
# 本地
dotnet restore PrdAgent.sln
```

### 步骤 5：编译验证
```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
# 必须 0 error
```

### 步骤 6：配置环境变量（用户提供时）
- 从用户提供的值设置 `MongoDB__ConnectionString`、`Redis__ConnectionString` 等
- **绝不在代码/日志中暴露实际密码值**

### 步骤 7：连通性测试（用户提供 DB 凭据时）
- 创建临时 .NET 项目测试 MongoDB + Redis 连接
- 报告连接状态和延迟

### 步骤 8：报告结果
列出各组件版本、连接状态、已知问题
