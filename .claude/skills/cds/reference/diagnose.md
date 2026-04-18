# 故障诊断决策树

## CLI 入口

```bash
cdscli help-me-check <branchId>   # 自动抓数据 + 模式匹配
cdscli diagnose <branchId>        # 只抓数据不分析（原始素材）
```

## 数据源优先级

```
1. 分支状态 (status / errorMessage / services)  ← 最粗，最快
2. 容器日志 (container-logs per profile)        ← 看编译错误 / 运行时异常
3. 容器环境变量 (container-env)                 ← 看 env 是否注入
4. 最近操作历史 (branches/:id/logs)             ← 看卡在哪一步
5. 基础设施健康 (infra/:id/health)              ← MongoDB/Redis 正常？
```

## 根因模式库（cdscli help-me-check 内置）

| 日志模式 | 推断 | 建议修复 |
|---------|------|---------|
| `error CS\d+` | C# 编译错误 | `dotnet build --no-restore` 本地复现 → 按行号修复 |
| `connection refused` | 下游服务拒接 | 检查 infra (`cdscli branch status`), MongoDB/Redis 是否 running |
| `ENOENT.*node_modules` | 前端依赖缺失 | 容器内 `pnpm install` 或重新 deploy |
| `port \d+ already in use` | 端口冲突 | `POST /api/cleanup-orphans` |
| `EACCES` / `permission denied` | 权限问题 | 检查挂载卷 owner / 容器 user |
| `OutOfMemory` / `OOMKilled` | OOM | 加内存 or 优化启动占用 |
| `timeout.*exceeded` / `ETIMEDOUT` | 外部依赖超时 | LLM / 第三方 API 可达性 |
| `Invalid.*token` / `401 Unauthorized` / `未授权` | 认证失败 | 走 [auth.md](auth.md) 决策树 |

新模式请提 PR 补充到 `cmd_help_me_check` 的 `patterns` 列表。

## 决策树

```
status == error
│
├─ services.api.status == error
│   ├─ 日志含 "error CS"    → C# 编译错误 → 修代码
│   ├─ 日志含 "connection"  → infra 问题 → 检查 MongoDB/Redis
│   ├─ 日志含 "port in use" → /api/cleanup-orphans
│   ├─ 日志含 "ENOSPC"      → 磁盘满或 inotify 耗尽 → CDS 运维介入
│   └─ 容器不存在            → POST /branches/:id/reset 后再 deploy
│
├─ services.admin.status == error
│   ├─ 日志含 "ENOENT"       → pnpm install 失败 → 检查 node 版本
│   ├─ 日志含 "vite error"   → TS 编译错误 → 本地 tsc 看报错
│   └─ 日志含 "EADDRINUSE"   → 端口冲突
│
├─ services.*.status == starting （长时间卡住）
│   ├─ 超过 2min 仍 starting  → 看日志确认容器已 "listening"
│   └─ 日志 "listening"       → CDS 状态延迟 bug，cdscli 自动识别为 running
│
└─ 所有服务都 error
    └─ 基础设施 / 宿主机问题 → infra health + 宿主机磁盘内存
```

## 诊断报告示例

```
=== help-me-check 报告 [trace:a1b2c3d4] ===

branchId: claude/fix-xxx
status  : error
services: api=error, admin=running

[根因匹配]
pattern : error CS\d+
cause   : C# 编译错误
found in: logs.api line 123

[上下文]
  error CS0103: The name 'Foo' does not exist in the current context
  at Program.cs(42, 13)

[建议]
1. 本地 `cd prd-api && dotnet build --no-restore`
2. 修复 Program.cs:42
3. `cdscli deploy` 重新部署

[环境变量检查]
  envKeys 包含 AI_ACCESS_KEY: ✓
  envKeys 包含 JWT_SECRET   : ✓
```

## 未命中已知模式时

1. 输出全量 `logs.<profile>` 末尾 80 行，让 LLM 接手分析
2. 建议用户补充补丁到本文件的根因模式库
3. 如果完全看不懂 → 要求用户把 `cdscli diagnose <id> | tee /tmp/d.json` 贴给 LLM

## 常见伪阳性

| 现象 | 实际 | 处理 |
|------|------|------|
| status=starting 持续 2min+ | 容器已启动，CDS 状态延迟 | 看日志含 `listening on` 就算 running |
| 404 GET /api/global-agent-keys | CDS 是旧版本 | 用户升级 CDS |
| HTTP 500 空 body 调认证 API | Cloudflare 把 401 改写了 | 改走 container-exec 本地验证 |
| build_ts 跳过编译 | HEAD SHA sentinel 命中 | 这是正确行为（2026-04-18 修复后的机制） |
