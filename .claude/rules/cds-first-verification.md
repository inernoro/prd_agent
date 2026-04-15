# CDS 优先验证原则

> 本地没有 SDK 不是"无法验证"的理由。CDS 就是为这种场景准备的远端编译/部署/验证环境，**必须**用 CDS 跑，不能以"本地无 dotnet/无环境"为由提交未验证的代码。

## 强制规则

1. **本地 SDK 缺失 ≠ 无法验证**：当 AI Agent 所在环境没有 `dotnet` / `node` / `pnpm` / `cargo` 等构建工具时，**禁止**说"环境无 SDK，未能运行"就提交代码。CDS 永远是兜底验证通道，必须用。

2. **任何 .cs / .csproj / Program.cs / appsettings 改动**：完成开发后必须通过 `/cds-deploy` 触发 CDS 远端编译 + 部署 + 容器日志检查，等价于规则 #2「C# 静态分析」要求的 `dotnet build`。CDS 失败就是 `dotnet build` 失败，必须当场修复。

3. **任何 .ts / .tsx / vite 配置改动**：本地 `pnpm tsc + pnpm lint` 通过只能保证类型和静态规则，**仍需** CDS 部署后真人通过预览域名访问页面验收（规则 #8「Agent 开发完成标准」+ `e2e-verification.md`）。

4. **CDS 部署是异步链路的一部分**，不是"额外步骤"：开发完成 → 提交 → push → `/cds-deploy` → 等待绿灯 → 才能声称完成。跳过 CDS 验证就声称完成 = 违反规则 #8。

5. **优先 CDS，不要纠结本地**：当 AI 发现本地缺 SDK 时，**第一反应应该是 `/cds-deploy`**，而不是在交付文档里写"⚠ 环境无 SDK 未运行，请你或下一位 agent 自行验证"。把验证负担转嫁给用户是最糟糕的实践。

## 反面案例（真实发生过）

> 2026-04-15 更新中心功能开发时，AI 在沙箱里发现没有 dotnet SDK，于是写了"⚠ dotnet build 环境无 dotnet SDK 未能运行；C# 代码已两次通读自审"，把 C# 编译验证负担转嫁给用户。
>
> **正确做法**：当场用 `/cds-deploy` 推到 CDS 灰度环境，CDS 容器内的 .NET SDK 会真实编译；编译错误会出现在 `POST /api/branches/:id/container-logs` 返回里，AI 看到错误自己修，修完重新部署。整个过程 AI 自闭环，用户零参与。

## 决策树

```
完成代码改动
    │
    ▼
本地有对应 SDK？
    │
    ├─ 是 → 本地 build/lint 通过 → push → /cds-deploy 二次验证 → 完成
    │
    └─ 否 → 直接 push → /cds-deploy → 容器日志/状态验证 → 完成
                                          │
                                          ├─ 失败 → 看容器日志 → 修代码 → 重新部署
                                          │
                                          └─ 成功 → 才能声称完成
```

## 例外情况

以下场景**允许**跳过 CDS 验证：

- 仅修改 `doc/` 文档，无任何代码
- 仅修改 `.claude/skills/` `.claude/rules/` 等元数据
- 仅修改 `changelogs/` 碎片文件
- 仅修改 `README.md` / 注释类内容

凡是改动可执行代码（`.cs` / `.ts` / `.tsx` / `.rs` / `.cjs` / Dockerfile / docker-compose 等）就必须走 CDS 验证，无例外。

## 相关规则

- `e2e-verification.md`：端到端验收原则（API 200 ≠ 功能正常）
- `prd-api/CLAUDE.md` 规则 #2：C# 静态分析要求
- `CLAUDE.md` 规则 #8：Agent 开发完成标准
- `cds-deploy-pipeline` 技能：CDS 远端部署流水线工作流
