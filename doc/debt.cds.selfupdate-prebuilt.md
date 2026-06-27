# CDS 自更新极速版（预构建产物） · 债务台账

> **版本**：v1.0 | **日期**：2026-06-27 | **状态**：基础设施 + 决策/运行层已落地并验证；orchestrator 接线待真实环境灰度

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

## 待补：orchestrator 接线（open，需真实环境灰度）

`cds/src/routes/branches.ts` 的 self-update handler（约 18091 起）接入预构建快路径。**精确接线点**：

1. **入口判定**（在 `validate`（约 18136）之前）：
   - 读灰度开关 `CDS_SELFUPDATE_PREBUILT`（默认 off）+ `!forceMode`（force 语义是「我要看真重启」，跳过快路径）。
   - `decision = shouldTryCdsPrebuilt({ enabled, repoFullName, sha: <newHead 完整 40 SHA> })`。注意 `newHead` 需是**完整 40 位** SHA（现有变量多为短 SHA，需 `git rev-parse HEAD` 取全 SHA，或复用 worktree.ts 的 afterFull 思路）。
   - `decision.use` → `fetchCdsPrebuilt(deps, decision.imageRef, fullSha, '<cds>/.cds/prebuilt-staging')`。
2. **成功**：把 staging 的 `distDir` 内容灌进现有管线的 `dist.next`（现有原子替换 18255 直接消费），web 用 staging 的 `webDistDir` **原子替换** `web/dist`（替代 `runInProcessWebBuild` 18306 的 vite）。
   - **跳过** `validate`（18136-18203，产物已被 CI tsc 门校验过）与 `build-backend` esbuild（18218-18253）。
   - **复用** 原子 swap（18255）+ nginx-render（18290）+ drain/record/restart（18334-18369）不变。
   - record 的 self-update 记 `updateMode: 'prebuilt'`，前端历史可标「极速版」。
3. **失败 / 开关 off**：什么都不做，**落到现有本机现编路径**——行为零变化（这是安全底线）。

实现建议：把「灌 dist.next + 原子 swap + 重启」抽成一个共享 helper，prebuilt 与现编两路都调，避免在巨型 handler 里改控制流出错。或写成自包含的 flag-gated 块：成功则自己做完 swap+restart 并 return，否则 fall through（现有路径 100% 不动，flag-off 可证零回归）。

### 为什么没在 PR #940 内接线

self-update 是**会把 CDS 自己弄死的高危路径**（代码里有 "bootstrap trap" 注释：编坏了连自己 API 都救不回）。
本沙箱**无法端到端真测** docker pull → cp 解出 → 原子替换 → 重启这一串（CLAUDE §8.1 自测优先）。
故只落地可单测的三层（已验证），接线留给有真实 CDS 实例可灰度的环境：

- 接线后先 `export CDS_SELFUPDATE_PREBUILT=1`，对一个**非生产** CDS 自更新一次，确认「拉产物 → 替换 → 重启 → 起来」全程通；
- 再确认「故意删掉该 SHA 的 ghcr 镜像 → 自更新自动回退本机现编」；
- 两条都过，才在生产开启开关。

## 相关

- `cds/src/services/cds-prebuilt.ts` / `cds-prebuilt-runtime.ts` —— 决策 + 拉取（已测）
- `.github/workflows/cds-prebuilt.yml` / `cds/Dockerfile.dist` —— CI 产物（已绿）
- `doc/debt.cds.ci-prebuilt.md` —— 项目分支极速版（同族：编译卸到 CI）
- `cds/src/routes/branches.ts` self-update handler —— 待接线点
