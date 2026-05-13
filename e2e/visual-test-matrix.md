# CDS Branch Runtime Visual Test Matrix

日期: 2026-05-13
目标环境: `https://cds.miduo.org`
对应提交: `1dc08110 fix: show container logs in deployment phases`
当前追加验证提交: `1dc08110`

## 可复用技能搜索

使用 `find-skills` 执行 `npx skills find playwright visual e2e`，找到以下候选:

| 技能 | 用途判断 | 本次处理 |
| --- | --- | --- |
| `alinaqi/claude-bootstrap@playwright-testing` | Playwright 测试流程，可作为通用测试技能 | 暂不安装；仓库已有 `e2e/` Playwright 基础设施 |
| `erichowens/some_claude_skills@playwright-e2e-tester` | Playwright e2e 测试辅助 | 暂不安装 |
| `agents-inc/skills@web-testing-playwright-e2e` | Web e2e 测试辅助 | 暂不安装 |
| `curiositech/some_claude_skills@playwright-e2e-tester` | Playwright e2e 测试辅助 | 暂不安装 |

## 视觉测试表

| ID | 测试目的 | 操作方式 | 期望结果 | 最终效果 |
| --- | --- | --- | --- | --- |
| V-01 | 验证源码版不再显示特殊运行模式标识 | 登录 CDS，打开分支列表，扫描 `.branch-runtime-source` | 源码版卡片没有“源码”badge；只保留端口、标签、时间等必要信息 | ✅ 通过：`cds-branch-runtime-visual.spec.ts` 第 1 条通过 |
| V-02 | 验证发布版仍有明确标识 | 登录 CDS，打开分支列表，扫描发布/混合运行模式文案 | 发布版显示“发布版”badge；混合模式显示“混合”badge | ❌ 未完全验收：当前测试环境未稳定命中发布/混合卡片时自动 skip；需保留作发布分支存在时的回归项 |
| V-03 | 验证卡片时间口径是最近部署尝试/成功/失败 | 登录 CDS，打开分支列表，检查卡片时间文案和 title | 文案包含“部署 xx 前”；title 明确“最近一次部署尝试/成功/失败” | ✅ 通过：`cds-branch-runtime-visual.spec.ts` 第 3 条通过 |
| V-04 | 验证构建中卡片有显眼耗时 | 找到构建中/启动中分支卡片，检查 `.branch-build-elapsed` | 卡片 chip 显示“构建 00:xx”或“启动 00:xx”，并逐秒更新 | ❌ 未触发：当前测试窗口没有稳定构建中分支；保留为手动/CI 事件触发项 |
| V-05 | 验证详情抽屉部署卡片耗时可见 | 从分支列表点击卡片打开右侧详情抽屉，进入“部署”tab | 右上角有“已用/耗时 xx”胶囊，不再只是弱灰小字 | ✅ 通过：真实线上列表页右侧抽屉部署 tab 可见耗时信息 |
| V-06 | 验证详情抽屉挂载真实容器日志 | 从分支列表点击卡片打开右侧详情抽屉，进入“部署”tab，查看阶段树下的“容器日志” | 存在可展开“容器日志”区域；running 时默认展开，success/error 时可展开查看 | ✅ 通过：`summary 容器日志` 已在列表页右侧抽屉中出现；不是 `/branch-panel` 页面 |
| V-07 | 验证切换运行模式只影响当前分支 | 代码审查 `switchModeAndDeploy` 与 React 抽屉保存逻辑 | 只调用 `/branches/:id/profile-overrides/:profileId`，不再写 `/build-profiles/:id/deploy-mode` | ✅ 通过：legacy 与 React 抽屉均为分支 override；未执行线上变更动作 |
| V-08 | 验证切换运行模式会真正触发本分支重新部署 | 代码审查 React 抽屉保存逻辑；不自动点击线上 redeploy | 保存 profile override 后调用 `/api/branches/:id/deploy`；不会只显示保存动画 | ✅ 通过：代码路径已调用当前分支 deploy；未执行线上变更动作 |
| V-09 | 验证线上基础页面可打开 | 运行现有 `e2e` smoke against `https://cds.miduo.org` | `/login` 和 `/` 可打开，登录页字段可见，无关键 console error | ❌ 部分通过：登录页与根路径通过；CSS body 背景断言不适配当前透明 body，需单独调整 smoke 断言 |

## 已执行记录

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-05-13 | `npx skills find playwright visual e2e` | 找到 4 个候选 skill；未安装，复用现有 Playwright |
| 2026-05-13 | `E2E_BASE_URL=https://cds.miduo.org pnpm --dir e2e test` | 提权前 Chromium 被 macOS sandbox 拦截；提权后 2 passed / 5 failed，旧 smoke 选择器和 body 背景断言过期 |
| 2026-05-13 | `E2E_BASE_URL=https://cds.miduo.org E2E_USER=... E2E_PASSWORD=... pnpm --dir e2e test specs/cds-branch-runtime-visual.spec.ts` | 真实抽屉路径：2 passed / 1 skipped / 1 failed；失败点为 V-06 容器日志未挂入详情抽屉阶段树 |
| 2026-05-13 | `self-update` 到 `1dc08110` | 线上 CDS `headSha=1dc08110`，`webBuildSha=1dc08110...`，`remoteAheadCount=0` |
| 2026-05-13 | `E2E_BASE_URL=https://cds.miduo.org E2E_USER=... E2E_PASSWORD=... pnpm --dir e2e test specs/cds-branch-runtime-visual.spec.ts` | 真实列表页右侧抽屉路径：3 passed / 1 skipped；V-01、V-03、V-06 通过，V-02 因当前环境未稳定命中发布/混合卡片而 skip |

## 测试命令

```bash
E2E_BASE_URL=https://cds.miduo.org pnpm --dir e2e test
```

需要登录态的视觉检查使用:

```bash
E2E_BASE_URL=https://cds.miduo.org E2E_USER=<user> E2E_PASSWORD=<password> pnpm --dir e2e test specs/cds-branch-runtime-visual.spec.ts
```
