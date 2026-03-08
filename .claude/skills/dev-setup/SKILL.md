# Skill: 开发环境搭建与本地调试

> 触发词：`装环境`、`环境搭建`、`setup env`、`dev env`、`还原环境`、`restore env`、`测试连接`、`test connectivity`、`dotnet restore`、`环境调试`、`本地验证`、`local verify`、`沙箱能力`、`sandbox check`、`自动测试`、`端到端测试`、`E2E 测试`、`集成测试`、`真实请求调试`、`验证修复`

## 概述

两阶段一体化技能：**阶段 A** 完成开发环境安装、配置与能力验证；**阶段 B** 通过真实 API 调用 + 日志分析进行自动化测试与调试。自动检测运行模式（本地 CLI / 云端 Web 沙箱），对已知平台限制自动绕过。

## 核心原则

1. **环境变量驱动**：所有密码/密钥通过环境变量传入，绝不硬编码到代码
2. **幂等执行**：重复运行不会破坏已有环境
3. **真实验证**：不靠假设，用实际命令验证能力
4. **双模自适应**：自动区分本地 CLI 与 Web 沙箱，选择对应策略
5. **先观察再修改**：通过真实调用获取实际行为，而非假设
6. **最小化变更**：每次只改一处，确认效果后再改下一处

---

# 阶段 A：环境搭建与验证

## A.1 两种运行模式

| 维度 | 本地 CLI 模式 | Claude Code Web 沙箱模式 |
|------|-------------|------------------------|
| 运行环境 | 用户本机终端 | Anthropic 托管 Ubuntu 容器 |
| .NET SDK | 用户自行安装，完全可控 | 需通过 `dotnet-install.sh` 安装 |
| `dotnet restore` | 正常工作 | **需启动代理中继**（.NET HttpClient 代理认证 Bug） |
| `dotnet build` | 正常工作 | 正常工作（restore 完成后） |
| `dotnet test` | 正常工作 | **纯逻辑测试可行，涉及外部 DB 的测试不行** |
| `apt-get` | 正常工作 | 受限（部分源不可达） |
| 网络访问 | 无限制 | JWT 认证 Envoy 代理，仅允许 HTTP/HTTPS |
| 外部数据库 | 正常连接 | **被 Envoy 代理阻断** |
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

## A.2 Web 沙箱网络限制

Web 沙箱的出口流量通过 **Envoy 代理** 转发：

| 协议 | 能否通过 | 原因 |
|------|---------|------|
| HTTP/HTTPS (443/80) | 可以 | Envoy 原生支持 |
| MongoDB (27017) | **不行** | Envoy DPI 拒绝非 HTTP 流量 |
| Redis (6379) | **不行** | RESP 协议被识别为非 HTTP |
| 任意 TCP (非 HTTP) | **不行** | CONNECT 隧道建立后，Envoy 检测到非 TLS/HTTP 流量即断开 |

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

## A.3 SDK 安装清单

| SDK | 版本要求 | 用途 | 安装方式 |
|-----|---------|------|---------|
| .NET SDK | 8.0.x | 后端 `prd-api` (C# 12, ASP.NET Core 8) | `dotnet-install.sh` |
| Node.js | 22.x | 前端 `prd-admin`, `prd-desktop`, `prd-video` | nvm |
| pnpm | latest | 前端包管理器 | npm install -g |
| Rust | stable (edition 2021) | Tauri 桌面端 `prd-desktop/src-tauri` | rustup |
| tauri-cli | latest | Tauri 构建工具 | cargo install |
| Python 3 | 3.10+ | `prd-video/scripts` + NuGet 代理中继 | 系统包管理器 |

### Linux 系统依赖 (Ubuntu/Debian, 仅本地模式需要)

```bash
sudo apt-get install -y \
  build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
```

---

## A.4 一键安装

### 方式 A：完整一键脚本（本地推荐）

```bash
bash scripts/setup-dev-env.sh
```

### 方式 B：SessionStart Hook（Web 沙箱自动触发）

```bash
bash .claude/hooks/session-start.sh
```

### 方式 C：手动分步安装

#### .NET 8 SDK

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

## A.5 dotnet restore 在 Web 沙箱中的特殊处理

### 问题根源

Claude Code Web 的出口代理使用 JWT Token 认证。.NET HttpClient 在 Linux 上存在已知 Bug（[dotnet/runtime#114066](https://github.com/dotnet/runtime/issues/114066)），无法正确发送 `Proxy-Authorization` 头。

### 解决方案：NuGet 代理中继

```bash
# 启动代理中继
python3 scripts/nuget-proxy-relay.py &
RELAY_PID=$!

# 通过中继执行 restore
HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 \
  dotnet restore PrdAgent.sln

# 完成后停止中继
kill $RELAY_PID
```

---

## A.6 能力矩阵验证

### SDK 版本验证

```bash
echo "=== SDK Versions ==="
dotnet --version 2>/dev/null || echo "dotnet: MISSING"
node -v 2>/dev/null || echo "node: MISSING"
pnpm -v 2>/dev/null || echo "pnpm: MISSING"
rustc --version 2>/dev/null || echo "rustc: MISSING"
cargo --version 2>/dev/null || echo "cargo: MISSING"
python3 --version 2>/dev/null || echo "python3: MISSING"
```

### 后端编译验证（CLAUDE.md 强制规则）

```bash
cd prd-api && dotnet build --no-restore 2>&1 | tail -5
dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

### 前端构建验证

```bash
cd prd-admin && npx tsc --noEmit 2>&1 | tail -10
```

---

## A.7 环境变量配置

### 必需环境变量

| 环境变量 | 映射到 | 默认值 | 说明 |
|---------|--------|--------|------|
| `MongoDB__ConnectionString` | `MongoDB:ConnectionString` | `mongodb://localhost:27017` | MongoDB 连接串 |
| `MongoDB__DatabaseName` | `MongoDB:DatabaseName` | `prdagent` | 数据库名 |
| `Redis__ConnectionString` | `Redis:ConnectionString` | `localhost:6379` | Redis 连接串 |
| `Jwt__Secret` | `Jwt:Secret` | (dev 有默认值) | JWT 签名密钥，>=32 字节 |
| `ASPNETCORE_ENVIRONMENT` | - | `Production` | 设为 `Development` 开启调试 |

---

## A.8 数据库连接测试

### 快速连通性测试

```bash
export MONGODB_HOST=<host>
export MONGODB_PASSWORD='<password>'
export REDIS_HOST=<host>
export REDIS_PASSWORD='<password>'
```

### 通过 API 服务验证

```bash
export ASPNETCORE_ENVIRONMENT=Development
export Jwt__Secret="dev-only-change-me-32bytes-minimum!!"
cd prd-api && dotnet run --project src/PrdAgent.Api -- --urls "http://localhost:5000"

# 另一终端
curl http://localhost:5000/swagger/index.html -o /dev/null -w "HTTP %{http_code}\n"
```

### Web 沙箱中的 DB 连接

**结论**：Web 沙箱中无法连接外部 MongoDB/Redis，沙箱内仅做编译 + 静态分析 + 纯逻辑测试。

---

## A.9 常见问题排查

| 问题 | 模式 | 排查方式 |
|------|------|---------|
| `dotnet: command not found` | 两者 | 检查 `DOTNET_ROOT` 和 `PATH` |
| NuGet `401 Unauthorized` | Web | 启动 `nuget-proxy-relay.py` 后重试 |
| NuGet `403 Access Denied` | Web | 用 `dotnet-install.sh` 替代 `apt install` |
| MongoDB 连接超时 | Web | **沙箱限制，无解**，改用本地 CLI 模式 |
| MongoDB 连接超时 | 本地 | 检查防火墙 27017、密码 URL 编码 |
| Redis 连接失败 | Web | **沙箱限制，无解** |
| Tauri 编译失败 | 本地 | 检查 webkit2gtk 等系统库 |
| `dotnet build` warning CS | 两者 | 评估是否本次改动引入 |

---

# 阶段 B：自动化测试与调试

## B.1 通用调试流程

### 步骤 1：确定测试目标

- 明确要测试的功能/接口
- 确定预期结果
- 准备测试数据

### 步骤 2：环境就绪检查

```bash
curl -s --max-time 5 "{BASE_URL}/health"
```

### 步骤 3：执行测试调用

```bash
curl -X POST "{ENDPOINT}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {TOKEN}" \
  -d '{
    "field1": "value1",
    "field2": "value2"
  }'
```

### 步骤 4：收集诊断信息

**HTTP 错误时**：
- `curl -s -w "\nHTTP: %{http_code}" ...`
- 读取响应体中的错误信息
- 检查服务端日志

**异常堆栈时**：
- 定位异常发生的代码位置（文件:行号）
- 理解异常类型和消息
- 分析上下文变量状态

### 步骤 5：问题定位

| 现象 | 可能原因 | 排查方向 |
|------|----------|----------|
| 500 Internal Error | 未处理的异常 | 查看服务端控制台的堆栈 |
| 502 Bad Gateway | 上游服务调用失败 | 检查 LLM/外部服务日志 |
| 400 Bad Request | 请求参数错误 | 检查请求体格式、必填字段 |
| 数据不符预期 | 业务逻辑问题 | 断点调试或添加日志 |
| 调用未发生 | 前置条件未满足 | 检查配置、权限、条件判断 |

### 步骤 6：修复与验证

```bash
# 1. 修改代码
# 2. 编译
dotnet build {PROJECT}.csproj -v q      # .NET
npm run build                            # Node.js
cargo build                              # Rust

# 3. 提示用户重启服务
# 4. 重复步骤 3-5 直到成功
```

---

## B.2 LLM 调用场景的特殊处理

当功能涉及 LLM 调用时，**必须检查 LLM 日志**：

```bash
curl -s "{BASE_URL}/api/logs/llm?limit=10" \
  -H "X-AI-Access-Key: {KEY}" \
  -H "X-AI-Impersonate: admin" | jq '.data.items[] | {
    purpose: .requestPurpose,
    model: .model,
    status: .status,
    error: .error,
    duration: .durationMs
  }'
```

**常见 LLM 调用问题**：

| 问题 | 日志特征 | 修复方向 |
|------|----------|----------|
| 调用未发生 | 无对应 purpose 的记录 | 检查代码是否执行到调用处 |
| 请求数据丢失 | requestBody 缺少关键字段 | 检查序列化逻辑 |
| 模型无响应 | status=failed, TIMEOUT | 增加超时或换模型 |
| 上游服务问题 | HTTP 5xx | 等待恢复或换模型池 |
| 响应不符预期 | status=succeeded 但结果错 | 调整 Prompt 或换模型 |

---

## B.3 多步骤链路调试

当功能包含多个步骤时（如 A -> B -> C）：

1. **确认每步是否执行**：检查日志中是否有各步骤的记录
2. **检查步骤间数据传递**：前一步的输出是否正确传给下一步
3. **定位首个失败点**：从第一个失败的步骤开始排查

---

## B.4 迭代调试模式

```
发现问题 -> 定位原因 -> 修复代码 -> 编译 -> 重启 -> 验证 -> (循环直到成功)
```

每次迭代：
- 只改一处，验证一处
- 记录每次修改的内容
- 如果修复无效，回滚并尝试其他方案

---

## B.5 平台特定命令参考

| 操作 | Linux/Mac | Windows PowerShell |
|------|-----------|-------------------|
| HTTP GET | `curl -s URL` | `Invoke-RestMethod URL` |
| HTTP POST | `curl -X POST -d 'data' URL` | `Invoke-RestMethod -Method Post -Body 'data' URL` |
| JSON 格式化 | `jq .` | `ConvertTo-Json -Depth 5` |
| 查看文件尾部 | `tail -f file.log` | `Get-Content file.log -Wait` |
| 环境变量 | `export VAR=value` | `$env:VAR="value"` |

---

# AI 执行此技能时的操作流程

## 环境搭建（阶段 A 触发词触发）

1. **环境检测 + 模式判断** → SDK 检查 + Web/本地判断
2. **安装缺失 SDK** → 按需安装
3. **Web 沙箱** → 启动 NuGet 代理中继
4. **dotnet restore** → 包还原
5. **编译验证** → `dotnet build --no-restore`（0 error）
6. **前端依赖** → `pnpm install`
7. **能力报告** → 输出结构化报告

## 自动化调试（阶段 B 触发词触发）

1. **确定测试目标** → 明确接口与预期结果
2. **环境就绪检查** → health check
3. **执行测试调用** → curl 发起请求
4. **收集诊断信息** → 状态码 + 响应体 + 日志
5. **问题定位** → 结合日志证据定位
6. **修复与验证** → 迭代修复直到成功

## 注意事项

- 不要猜测问题原因，用日志和实际响应作为证据
- 遇到上游服务问题（如 503），先确认是否为临时问题
- 优先使用 curl，跨平台兼容性最好
- **绝不在代码/日志中暴露实际密码值**
