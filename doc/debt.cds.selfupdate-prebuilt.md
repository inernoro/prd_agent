# CDS 自更新极速版（预构建产物） · 债务台账

> **版本**：v1.1 | **日期**：2026-07-20 | **状态**：已接线（灰度开关默认开，待生产观察窗口）

## 总览

把 CDS 自更新的「本机现编」（tsc 52s + vite 1.6min ≈ 3min）改为「拉 CI 预构建产物 + 原子替换 + 重启」（几十秒）。
与项目极速版同理：编译卸到 GitHub Actions，自更新只「拉 + 换 + 起」。

用户诉求（2026-06-27）：「既然代码被 CI 编译了，自更新就该拉现成的、不要本机再编一遍。」

## 已完成（已验证）

| 层 | 文件 | 状态 |
|---|---|---|
| CI 预构建 | `.github/workflows/cds-prebuilt.yml` + `cds/Dockerfile.dist` | **完成 + CI run 已 success**。push 改 `cds/**` → 编译（tsc 门 + esbuild 后端 + vite 前端）→ ghcr `cds-dist:sha-<40hex>` |
| 决策纯函数 | `cds/src/services/cds-prebuilt.ts` | **完成 + 10 单测**。`computeCdsPrebuiltImageRef`（与 CI 同公式）/ `parseCdsPrebuiltManifest` / `shouldTryCdsPrebuilt`（灰度开关） |
| 运行层拉取 | `cds/src/services/cds-prebuilt-runtime.ts` | **完成 + 8 单测**。`fetchCdsPrebuilt`：docker pull/create/cp 解出 `/dist` `/web-dist` 到 staging + 校验 manifest；失败 `ok:false` 供回退 |
| orchestrator 接线 | `cds/src/routes/branches.ts` 的 `tryApplyCdsPrebuiltForSelfUpdate` | **已接线**。`!forceMode` 时先判 `shouldTryCdsPrebuilt` → `fetchCdsPrebuilt` → `validateWebDistCandidate` 校验入口 HTML/JS/CSS 真实存在 → `replaceDirectoriesAtomically` 原子替换 `dist` 与 `web/dist` → 写 `.build-sha` 标记；命中后额外跑一次 `nginx-render` 用预构建 dist 重渲染模板。命中失败或 `applied=false` 时**原地 fall through 到本机现编路径**（`if (!prebuiltApplied) { ... }`），行为零回归 |

**⚠ 与本文档 v1.0 描述不同的地方（2026-07-20 核对代码后更正）**：灰度开关 `CDS_SELFUPDATE_PREBUILT` 的默认值是**开**，不是"默认 off"——`selfUpdatePrebuiltEnabled()` 只在值命中 `0/false/off/no` 时才关闭，未设置该变量时视为启用。生产环境如需继续走本机现编，必须显式设置 `CDS_SELFUPDATE_PREBUILT=0`。

## 近期相关补丁（同一 self-update 路径，2026-07-20 落地）

以下三个改动都改的是 `tryApplyCdsPrebuiltForSelfUpdate` / self-update handler 同一条路径，记录于此避免散在 commit message 里：

- **原子切换保留上一代 web 资源**（`replaceDirectoriesAtomically` 新增 `previousPath` 参数）：切换 `web/dist` 时把旧产物移到 `web/dist.previous` 而不是直接删除，修复自更新后已打开的浏览器标签页请求到新 `index.html` 但旧懒加载 chunk 已被删除导致的黑屏（跨代不一致）。同时 `validateWebDistCandidate` 会真实解析候选 `index.html` 的 `src`/`href`，逐个校验入口资源存在且非空，不再只查 `index.html` 是否存在。
- **生产更新防护（乐观锁 + 精确 SHA 重启）**：共享控制面的非快进更新（版本回退 / 跳跃）现在要求显式 `intent`（`release`/`rollback`）+ `expectedFromSha` 乐观锁 + `reason` 审计原因；同 SHA 与快进更新保持旧客户端兼容路径。新增不拉代码、不切分支、仅按精确 SHA 重启当前工作区的接口和 `cdscli` 命令。另修复 `cdscli` 收到 self-update SSE `error` 事件后仍返回成功退出码的问题。
- **渐进式 Agent 操作者身份**：新增 `agent-operation-context.ts` + `actor-resolver.ts`，采集调用方 Agent session，贯通请求 ID、操作 ID 与服务端事件日志，self-update / 精确 SHA 重启的结果会带上这三个标识供复盘关联；旧版不带身份信息的客户端调用保持兼容（身份字段全部可选）。

## 尚未验证（open）

- 生产环境尚未确认「命中 ghcr 镜像 → 拉取 → 原子替换 → 重启 → 起来」与「镜像缺失 → 自动回退本机现编」两条路径的真实灰度表现——本仓库沙箱无法端到端起 Docker 验证（CLAUDE §8.1）。
- `updateMode: 'prebuilt'` 已在 `types.ts` 声明并在 handler 中赋值，前端历史列表是否已按此值展示「极速版」标签待核对 UI 侧。

## 相关

- `cds/src/services/cds-prebuilt.ts` / `cds-prebuilt-runtime.ts` —— 决策 + 拉取（已测）
- `.github/workflows/cds-prebuilt.yml` / `cds/Dockerfile.dist` —— CI 产物（已绿）
- `doc/debt.cds.ci-prebuilt.md` —— 项目分支极速版（同族：编译卸到 CI）
- `cds/src/routes/branches.ts` 的 `tryApplyCdsPrebuiltForSelfUpdate` / `replaceDirectoriesAtomically` / `validateWebDistCandidate` —— 已接线的 self-update 快路径
- `cds/src/services/self-update-checkout.ts` / `agent-operation-context.ts` / `actor-resolver.ts` —— 生产更新防护与操作者身份采集
