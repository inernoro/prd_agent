# CDS 骨架维护与验收 · 指南

> **版本**：v1.0 | **日期**：2026-11-04 | **状态**：已落地

**一句话**：统一骨架的样式、路由登记和验收入口，避免代码加载与数据加载出现两套轮廓。
**谁该读**：维护 CDS 页面、加载组件和发布验收的工程师。
**读完能做什么**：找到需要修改的唯一入口，生成最新页面清单，并复验加载连续性。

## 从哪里改

| 要修改的内容 | 代码位置 | 更新规则 |
|---|---|---|
| 暖灰填色、轻呼吸、浅深主题、减少动效 | `cds/web/src/index.css` 的 `.cds-loading-skeleton-*` | 修改共享样式；不要在页面另写动画或颜色 |
| 控制台路由对应的加载轮廓、外壳尺寸 | `cds/web/src/components/skeletons/loading-scenes.json` | 控制台及有独立骨架的公共路由必须登记；实际外壳与目录共同读取 |
| 项目/分支列表轮廓 | `cds/web/src/components/skeletons/PageSkeletons.tsx` | 页面等待与路由等待引用同一个导出 |
| 登录代码/会话/登录方式等待与真实登录卡 | `cds/web/src/components/skeletons/AuthPageSkeleton.tsx` | 实际登录页和等待共用 AuthPageFrame；账号模式确认前只有同一副表单骨架 |
| 公开状态等待 | `cds/web/src/components/skeletons/PublicStatusSkeleton.tsx` | 代码与取数共用；首次失败退出骨架显示重试，不改变公开权限 |
| 系统设置、项目设置的导航和表单轮廓 | `cds/web/src/components/skeletons/SettingsSkeleton.tsx` | `SettingsPageSkeleton` 放整页；`SettingsContentSkeleton` 放内容区；页签内通过 `SettingsLoadingContext` 复用 |
| 发布控制台三栏轮廓和栏宽 | `cds/web/src/components/skeletons/ReleaseConsoleSkeleton.tsx` | 真实页与骨架共用布局常量；仅首次未取得项目/环境数据时使用整页骨架 |
| 发布中心/拓扑/Agent 请求的导航与筛选占位 | `cds/web/src/components/skeletons/WorkspaceSkeletons.tsx` | 整段轮廓共用，避免页头在两阶段之间把内容向下推 |
| 通用列表、表格、资源、日志占位 | `cds/web/src/components/skeletons/ContentLoading.tsx` | 根据真实内容选择 variant；慢等待提示预留高度 |
| 项目/分支列表跨代码与取数的慢提示 | `cds/web/src/components/skeletons/ListLoadingBoundary.tsx` | 提示只在工作区的固定高度槽位显示；路由与实际页面共用反馈，不新增外壳网格行 |
| 分支详情抽屉 | `cds/web/src/components/branch/BranchDrawerSkeleton.tsx` | 与总览共用关系/指标部件；不复制一套近似布局 |
| 指标、关系、监控等专业轮廓 | 下方命令生成的“定义位置” | 保留真实内容几何，共用暖灰样式 |
| 人工抽检预览 | 系统设置 → 加载页预览 | 展示真实导出组件；预览区域退出设置页骨架作用域 |

## 查页面、触发点和实际代码位置

```sh
pnpm --dir cds inventory:loading --out /tmp/cds-loading-inventory
```

打开输出目录的 `index.html`。目录包含路由、页面源码、骨架定义、每个 JSX 引用位置与所在函数、从页面静态引用可达的路由、加载分支分类。行号每次从当前源码重算；不要把旧截图报告里的行号当成后续维护入口。`inventory.json` 用于检索和工具对接。

“JSX 引用位置”包含预览与共享封装，不等于页面数或用户场景数。路由可达关系按静态 import 计算，跨共享组件可能列出多个入口；真实触发条件仍应查看对应函数。静态分类不等于运行时全部权限与接口组合验收。

## 必须保持的行为

1. 首次代码与首次数据等待使用同一个组件；外壳的宽度、边距、列宽随登记保持一致。
2. 已有内容刷新时保留内容和输入焦点，显示真实刷新状态；失败提示说明当前保留的是旧内容，允许重试。
3. 更换项目/分支、关闭抽屉和卸载时取消请求或丢弃旧响应；旧资源不能覆盖新资源。
4. 数据返回立即显示；不加演示延迟。空状态只在请求成功且结果为空时出现；失败不能留成永久骨架。
5. 骨架不渲染可操作控件；等待提示预留空间；支持浅深主题、窄屏和 `prefers-reduced-motion`。
6. 按钮保存/部署、SSE、数据库探测等使用真实动作或阶段反馈，不强行替换成整页骨架，不伪造进度。

## 修改后的检查入口

```sh
pnpm --dir cds audit:loading
pnpm --dir cds exec vitest run tests/web/loading-scene-registry.test.ts tests/web/single-skeleton-contract.test.ts tests/web/settings-single-skeleton.test.ts tests/web/loading-coverage.test.ts
pnpm --dir cds/web exec tsc --noEmit
pnpm --dir cds/web build
# 启动该构建的本机 preview 后执行；所有 API 均为脚本内合成数据，无付费模型请求：
pnpm --dir cds smoke:loading http://127.0.0.1:8870 --out /tmp/cds-loading-smoke
```

CDS Prebuilt CI 在发布产物前运行真实 Chromium 连续性与相邻场景验收。新增控制台路由未登记会被 Vitest 拦住；新增裸等待分支会由覆盖检查报告位置。登记不证明页面布局正确，因此浏览器仍需分开验证代码等待、数据等待和内容就绪，尤其不能只看预览组件截图。发布前还须全量测试、同提交 CI 和真实入口验收。

推荐抽检顺序：项目/分支列表 → 系统设置认证 → 项目设置 → 发布控制台 → 分支关系 → 抽屉资源。正常、慢请求、失败重试、快速切换、再次打开、390 窄屏、两主题和减少动效分别记录；网络节流只用于验收，不进入产品逻辑。

## 本轮边界

2026-11-04：同时修复登录三阶段轮廓、基础登录卡就绪高度与公开状态首载失败重试；补齐发布控制台、项目设置、发布中心、拓扑、Agent 请求的两阶段整段轮廓，并对齐监控高度；保留项目设置和关系图刷新内容并取消旧请求；通用慢等待提示预留空间。详细运行结果、截图与部署 SHA 随本次交付留存，不把本说明当作全部页面已逐权限实测的结论。
