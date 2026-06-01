## Cursor Cloud specific instructions

PRD Agent 是全栈 monorepo（`prd-api` + `prd-admin` + 可选 `prd-desktop` / `cds`）。Cloud Agent 默认只需跑通 **管理后台 + API + MongoDB + Redis** 即可做大部分开发验证。

### 首次 / 冷启动依赖

仓库提供一键脚本（会安装 .NET 8、Node 22、pnpm、Rust，并 `dotnet restore` + `pnpm install`）：

```bash
bash scripts/setup-dev-env.sh
source ~/.bashrc   # 若 dotnet 不在 PATH
```

`~/.bashrc` 已写入 `DOTNET_ROOT` 时，新 shell 会自动带上 `dotnet`。

### 基础设施（Docker）

本环境需 **sudo** 调用 Docker（用户默认不在 `docker` 组）：

```bash
sudo docker compose -f docker-compose.dev.yml up -d mongodb redis
```

- MongoDB：`localhost:18081`
- Redis：`localhost:18082`

### 本地联调栈（推荐，比整包 compose build 快）

`prd-admin` 的 Vite 代理目标是 **`http://localhost:5001`**（见 `prd-admin/vite.config.ts`），不是 5000。

**API**（tmux 示例，会话名可自定）：

```bash
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$DOTNET_ROOT/tools:$PATH"
export ASPNETCORE_ENVIRONMENT=Development
export ASPNETCORE_URLS=http://localhost:5001
export MongoDB__ConnectionString=mongodb://localhost:18081
export MongoDB__DatabaseName=prdagent
export Redis__ConnectionString=localhost:18082
# 无真实 COS 时用占位值即可启动（上传类功能会失败）
export TENCENT_COS_BUCKET=dev-bucket
export TENCENT_COS_REGION=ap-guangzhou
export TENCENT_COS_SECRET_ID=dev-secret-id
export TENCENT_COS_SECRET_KEY=dev-secret-key
export TENCENT_COS_PUBLIC_BASE_URL=https://example.com
cd prd-api && dotnet run --project src/PrdAgent.Api --no-launch-profile
```

**管理后台**：

```bash
cd prd-admin && pnpm dev --host 127.0.0.1
```

- 前端：http://127.0.0.1:8000
- 健康检查：http://localhost:5001/health
- 经代理的版本：http://127.0.0.1:8000/api/v

空库首次启动会种子用户 **`admin` / `admin`**（见 `DatabaseInitializer`）。登录 API：`POST /api/v1/auth/login`，body 含 `"clientType":"admin"`。

### 整包 Docker（与 README / Playwright 默认一致）

```bash
sudo docker compose -f docker-compose.dev.yml up -d --build
```

- Web（内置 admin 构建物）：http://localhost:5500
- API：http://localhost:5000（容器内 8080 映射）

`docker-compose.dev.yml` 的 `api` 服务依赖 `TENCENT_COS_*` 等环境变量；本机无密钥时需自行 export 或使用上文「本地联调栈」。

### 校验命令（见各子目录 `CLAUDE.md`）

| 模块 | 命令 |
|------|------|
| `prd-api` | `dotnet build --no-restore`；`dotnet test PrdAgent.sln --filter "Category!=Integration"` |
| `prd-admin` | `pnpm tsc --noEmit`；`pnpm lint`（仓库内已有大量历史 warning） |
| 可选 E2E | `cd e2e && pnpm install && E2E_BASE_URL=http://127.0.0.1:8000 pnpm test`（需 `E2E_USER` / `E2E_PASSWORD`） |

`PrdAgent.Tests` 中部分用例（如 `ApiRequestLogTwoPhaseStorageTests`）会连 Mongo 且未标 `Integration`，在仅跑单元测试时可能失败；`PrdAgent.Api.Tests` 的 `Category!=Integration` 套件更稳定。

### 其他服务

- **`cds/`**：独立分支预览平台，`./exec_cds.sh init && ./exec_cds.sh start`，与 PRD Agent 日常开发无关。
- **`prd-desktop`**：`pnpm tauri:dev`（需 Rust + 系统 GUI 依赖，Cloud VM 通常不跑）。
- **LLM / 对象存储**：需配置 `LLM__ClaudeApiKey`、`OPENROUTER_API_KEY` 或真实 `TENCENT_COS_*` 才能跑通 Agent 业务，不影响登录页与基础 API 冒烟。

更多细节见根目录 `README.md`、`CLAUDE.md` 与各子项目 `CLAUDE.md`。
