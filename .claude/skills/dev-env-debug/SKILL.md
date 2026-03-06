# Skill: 开发环境安装、调试与还原

> 触发词：`装环境`、`环境搭建`、`setup env`、`dev env`、`还原环境`、`restore env`、`测试连接`、`test connectivity`、`dotnet restore`、`环境调试`、`本地验证`、`local verify`、`沙箱能力`、`sandbox check`

## 概述

一键完成开发环境的安装、配置、本地验证和项目还原。自动检测运行模式（本地 CLI / 云端 Web 沙箱），对已知平台限制自动绕过，并提供完整的本地能力矩阵。

## 核心原则

1. **环境变量驱动**：所有密码/密钥通过环境变量传入，绝不硬编码到代码
2. **幂等执行**：重复运行不会破坏已有环境
3. **真实验证**：不靠假设，用实际命令验证能力
4. **双模自适应**：自动区分本地 CLI 与 Web 沙箱，选择对应策略

---

## 零、两种运行模式（重要前置知识）

| 维度 | 本地 CLI 模式 | Claude Code Web 沙箱模式 |
|------|-------------|------------------------|
| 运行环境 | 用户本机终端 | Anthropic 托管 Ubuntu 容器 |
| .NET SDK | 用户自行安装，完全可控 | 需通过 `dotnet-install.sh` 安装 |
| `dotnet restore` | 正常工作 | **需启动代理中继**（.NET HttpClient 代理认证 Bug） |
| `dotnet build` | 正常工作 | 正常工作（restore 完成后） |
| `dotnet test` | 正常工作 | **纯逻辑测试可行，涉及外部 DB 的测试不行** |
| `apt-get` | 正常工作 | 受限（部分源不可达） |
| 网络访问 | 无限制 | JWT 认证 Envoy 代理，仅允许 HTTP/HTTPS |
| 外部数据库 | 正常连接 | **被 Envoy 代理阻断**（见下方详解） |
| 前端 pnpm install | 正常工作 | 正常工作 |
| 前端 pnpm build/dev | 正常工作 | build 可行，dev 需端口转发 |

### 如何判断当前模式

```bash
if [ -n "$HTTPS_PROXY" ] && echo "$HTTPS_PROXY" | grep -q "container_"; then
  echo "Web sandbox mode"
else
  echo "Local CLI mode"
fi
```

---

## 一、Web 沙箱网络限制（关键结论）

### 已验证的限制

Web 沙箱的出口流量通过 **Envoy 代理** 转发，该代理具有以下特性：

| 协议 | 能否通过 | 原因 |
|------|---------|------|
| HTTP/HTTPS (443/80) | 可以 | Envoy 原生支持 |
| MongoDB (27017) | **不行** | Envoy 深度包检测 (DPI) 拒绝非 HTTP 流量 |
| Redis (6379) | **不行** | 同上，RESP 协议被识别为非 HTTP |
| 任意 TCP (非 HTTP) | **不行** | CONNECT 隧道建立后，Envoy 检测到非 TLS/HTTP 流量即断开 |
| MongoDB+SRV (TLS) | **未验证** | 理论上 TLS 封装可能通过，但 Envoy 可能按端口过滤 |

### 验证过程记录

1. **直接 TCP 连接**：`nc -zv host 27017` → 连接被代理拦截
2. **通过 CONNECT 隧道**：HTTP CONNECT 返回 200，但发送 MongoDB wire protocol 后连接被 reset
3. **socat 端口转发**：同样被 Envoy DPI 拦截
4. **结论**：沙箱环境无法访问任何非 HTTP 的外部服务

### 对开发的影响

| 开发活动 | 沙箱可行性 | 替代方案 |
|---------|-----------|---------|
| 代码编写 + 编译 | 完全可行 | - |
| 纯逻辑单元测试 | 完全可行 | Mock DB 依赖 |
| 集成测试（需 DB） | **不可行** | 本地 CLI 模式运行 |
| API 启动（需 DB） | **不可行** | 本地 CLI 模式运行 |
| 前端构建 | 完全可行 | - |
| NuGet/npm 包还原 | 可行（需代理中继） | - |
| Git push/pull | 完全可行 | - |

---

## 二、SDK 安装清单

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

## 三、一键安装

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

## 四、dotnet restore 在 Web 沙箱中的特殊处理

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

## 五、本地能力矩阵（沙箱内可执行的完整验证清单）

当 AI 被触发此技能时，按以下矩阵逐项验证，快速确认当前环境的完整能力。

### 5.1 SDK 版本验证

```bash
echo "=== SDK Versions ==="
dotnet --version 2>/dev/null || echo "dotnet: MISSING"
node -v 2>/dev/null || echo "node: MISSING"
pnpm -v 2>/dev/null || echo "pnpm: MISSING"
rustc --version 2>/dev/null || echo "rustc: MISSING"
cargo --version 2>/dev/null || echo "cargo: MISSING"
python3 --version 2>/dev/null || echo "python3: MISSING"
```

### 5.2 后端编译验证（CLAUDE.md 强制规则）

```bash
cd prd-api && dotnet build --no-restore 2>&1 | tail -5
# 必须看到 "Build succeeded" 且 0 error
dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

### 5.3 前端构建验证

```bash
# TypeScript 类型检查
cd prd-admin && npx tsc --noEmit 2>&1 | tail -10

# Vite 构建（可选，耗时较长）
# cd prd-admin && pnpm build
```

### 5.4 dotnet test（纯逻辑测试）

```bash
# 列出所有测试项目
find prd-api -name "*.Tests.csproj" -o -name "*Tests*.csproj" 2>/dev/null

# 运行不依赖外部服务的测试（如有）
# dotnet test prd-api/tests/SomeUnit.Tests --no-restore --filter "Category!=Integration"
```

### 5.5 Roslyn 静态分析

```bash
# CLAUDE.md 强制要求：任何 .cs 改动后必须执行
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
# 判定：error CS = 必须修复，warning CS = 评估是否本次引入
```

### 5.6 Git 状态

```bash
git status --short
git log --oneline -5
git branch -a | head -20
```

---

## 六、环境变量配置

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

## 七、数据库连接测试

### 7.1 快速连通性测试

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

### 7.2 通过 API 服务验证

```bash
export ASPNETCORE_ENVIRONMENT=Development
export Jwt__Secret="dev-only-change-me-32bytes-minimum!!"
cd prd-api && dotnet run --project src/PrdAgent.Api -- --urls "http://localhost:5000"

# 另一终端
curl http://localhost:5000/swagger/index.html -o /dev/null -w "HTTP %{http_code}\n"
# 应返回 HTTP 200
```

### 7.3 Web 沙箱中的 DB 连接（不可行）

**结论**：Web 沙箱中无法连接外部 MongoDB/Redis。

已验证的失败路径：
1. 直接 TCP → Envoy 代理拦截非 HTTP 流量
2. HTTP CONNECT 隧道 → Envoy DPI 检测到非 HTTP 内容后断开
3. socat 本地端口转发 → 同样被拦截

**替代方案**：
- 沙箱内仅做编译 + 静态分析 + 纯逻辑测试
- 需要 DB 的集成测试/API 启动 → 本地 CLI 模式

---

## 八、常见问题排查

| 问题 | 模式 | 排查方式 |
|------|------|---------|
| `dotnet: command not found` | 两者 | 检查 `DOTNET_ROOT` 和 `PATH`，运行 `source ~/.bashrc` |
| NuGet `401 Unauthorized` | Web | 启动 `nuget-proxy-relay.py` 后重试 |
| NuGet `403 Access Denied` | Web | .NET CDN 被代理拦截，用 `dotnet-install.sh` 替代 `apt install` |
| `apt-get update` 失败 | Web | 沙箱网络限制，改用 curl 直接下载 |
| MongoDB 连接超时 | Web | **沙箱限制，无解**，改用本地 CLI 模式 |
| MongoDB 连接超时 | 本地 | 检查防火墙 27017、密码特殊字符 URL 编码 |
| Redis 连接失败 | Web | **沙箱限制，无解**，改用本地 CLI 模式 |
| Redis 连接失败 | 本地 | 检查 6379 端口、`requirepass` 配置 |
| Tauri 编译失败 | 本地 | 检查 webkit2gtk 等系统库是否安装 |
| `pnpm install` 超时 | Web | 重试，或检查 npm registry 是否可达 |
| `dotnet build` warning CS | 两者 | 评估是否本次改动引入，如是则修复 |

---

## 九、Docker 一键启动（替代方案）

不安装 SDK，直接用 Docker：

```bash
# 本地构建全栈（API + MongoDB + Redis + Nginx）
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build

# 开发模式
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

---

## 十、AI 执行此技能时的操作流程

当 AI 被要求搭建/调试/验证环境时，按以下顺序执行：

### 步骤 1：环境检测 + 模式判断

```bash
# 一次性检测所有 SDK 和运行模式
echo "--- Mode ---"
echo $HTTPS_PROXY | grep -q "container_" 2>/dev/null && echo "WEB_SANDBOX" || echo "LOCAL"
echo "--- SDKs ---"
dotnet --version 2>/dev/null || echo "dotnet: MISSING"
node -v 2>/dev/null || echo "node: MISSING"
pnpm -v 2>/dev/null || echo "pnpm: MISSING"
rustc --version 2>/dev/null || echo "rustc: MISSING"
python3 --version 2>/dev/null || echo "python3: MISSING"
```

### 步骤 2：安装缺失 SDK（按需）

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

### 步骤 5：编译验证（CLAUDE.md 强制规则）

```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
# 必须 0 error
```

### 步骤 6：前端依赖安装

```bash
cd prd-admin && pnpm install
cd prd-desktop && pnpm install
cd prd-video && pnpm install
```

### 步骤 7：能力报告

输出结构化报告：

```
=== 环境验证报告 ===
模式: Web 沙箱 / 本地 CLI
.NET SDK: 8.0.xxx
Node.js: v22.x.x
pnpm: x.x.x
Rust: x.x.x

=== 可执行能力 ===
[OK] dotnet build (编译)
[OK] dotnet build 静态分析 (Roslyn)
[OK] pnpm install (前端依赖)
[OK] pnpm build / tsc (前端构建)
[OK] git 操作
[--] dotnet test (仅纯逻辑测试，DB 相关不可行)  ← 仅沙箱
[NO] MongoDB 连接  ← 仅沙箱
[NO] Redis 连接  ← 仅沙箱
[NO] API 启动 (依赖 DB)  ← 仅沙箱

=== 建议 ===
- 沙箱内：专注代码编写 + 编译 + 静态分析 + 前端构建
- 需要 DB 测试：请在本地 CLI 模式运行
```

### 步骤 8：配置环境变量（用户提供时）

- 从用户提供的值设置 `MongoDB__ConnectionString`、`Redis__ConnectionString` 等
- **绝不在代码/日志中暴露实际密码值**

### 步骤 9：连通性测试（仅本地模式 + 用户提供 DB 凭据时）

- 创建临时 .NET 项目测试 MongoDB + Redis 连接
- 报告连接状态和延迟
- **Web 沙箱中跳过此步骤**，直接告知用户沙箱限制
