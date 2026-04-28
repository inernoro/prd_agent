# CDS Web 前端 v2 迁移计划与交接

> **类型**：plan（实施计划） | **状态**：Week 1 已完成，Week 2-5 待执行
> **分支**：`claude/plan-project-restructure-URMVu`
> **作者**：Claude (Opus 4.7) · **日期**：2026-04-27
> **下棒**：可委托其他 AI / 开发者按本文 Week 2-5 路线图继续

---

## 一、为什么做这件事（30 秒读懂）

CDS 当前前端是 12k 行 `app.js` + 7.5k 行 `style.css` 的原生 HTML/JS/CSS 项目，每个新弹窗都要重写一遍：portal、focus trap、ESC 键、`min-h-0`、白天暗色 fallback、emoji 渗漏、`var(--xxx, #fallback)` 兜底色、按钮图标比例。最近 3 个月用户在同一类问题上反复反馈 10+ 次。

**根因**：没有组件抽象层，所有视觉规则都靠 markdown 规则文档手动 enforce。规则越多 → 漏掉的越多 → 越反复调试。

**方案**：把 4 个 HTML 页面（`cds-settings` / `settings` / `project-list` / `index`）渐进式迁移到 React + Vite + TypeScript + Tailwind + shadcn/ui。新栈与 prd-admin 同栈，可复用知识与代码。

---

## 二、Week 1 已完成内容（本 session 产出）

### 文件变更

| 类型 | 路径 | 说明 |
|------|------|------|
| 新增 | `cds/web-v2/package.json` | Vite 5 + React 18 + TS 5.6 + Tailwind 3.4 + Radix UI primitives |
| 新增 | `cds/web-v2/vite.config.ts` | base=`/v2/`，devProxy `/api` → `localhost:9900`，输出到 `cds/web-v2-dist/` |
| 新增 | `cds/web-v2/tsconfig.json` | strict + noUnusedLocals + `@/*` 别名指向 `src/*` |
| 新增 | `cds/web-v2/tailwind.config.js` | darkMode=`[data-theme="dark"]`，token 来自 CSS 变量 |
| 新增 | `cds/web-v2/postcss.config.js` | tailwind + autoprefixer |
| 新增 | `cds/web-v2/index.html` | 含 FOUC 阻断 inline script，`data-theme="dark"` 默认 |
| 新增 | `cds/web-v2/src/index.css` | dark + light 双主题 token，禁止 fallback |
| 新增 | `cds/web-v2/src/lib/utils.ts` | shadcn 标准 `cn()` helper |
| 新增 | `cds/web-v2/src/lib/api.ts` | `apiRequest<T>()` 封装，credentials: include |
| 新增 | `cds/web-v2/src/lib/theme.ts` | `useTheme()` hook，sessionStorage（per `no-localstorage` 规则） |
| 新增 | `cds/web-v2/src/components/ui/button.tsx` | shadcn Button + cva variants（icon size ≥55% 自动） |
| 新增 | `cds/web-v2/src/components/ui/card.tsx` | shadcn Card 系列 |
| 新增 | `cds/web-v2/src/components/ui/dialog.tsx` | Radix Dialog wrapper（替代 5 种手写 modal） |
| 新增 | `cds/web-v2/src/pages/HelloPage.tsx` | 4 项验证：Tailwind / 主题 / API / Dialog |
| 新增 | `cds/web-v2/src/App.tsx` | BrowserRouter basename=`/v2`，路由表见下 |
| 新增 | `cds/web-v2/src/main.tsx` | StrictMode 入口 |
| 修改 | `cds/src/server.ts` | `installSpaFallback` 接受可选 `v2DirOverride`；缺失时 warn，老页面零影响 |
| 修改 | `cds/tests/routes/server-integration.test.ts` | 新增 2 个测试守卫 `/v2` 挂载 + 复活接口边界 |

### 验证

```
cd cds && pnpm install && pnpm tsc --noEmit   → exit 0
cd cds && pnpm test                            → 860 tests pass（baseline 858 + 2 新增）
cd cds/web-v2 && pnpm install && pnpm build    → 76 KB gzipped 总包
```

bundle 拆分（gzip）：
- `react-vendor`: 52.30 KB（react + react-dom + react-router）
- `radix-vendor`: 11.80 KB（dialog + dropdown + tabs + slot）
- `index`: 11.85 KB（应用代码）
- `index.css`: 3.84 KB

### 边界保证

| 受保护对象 | 保证机制 |
|------------|----------|
| `POST /api/factory-reset`（复活接口） | `/api/*` 优先级永远高于 `/v2/*` mount，已被 `server-integration.test.ts:262` 测试守卫 |
| 老页面 `/index.html` `/cds-settings.html` `/project-list.html` `/settings.html` | `/v2/*` mount 仅匹配 `/v2/` 前缀，老 SPA fallback 不变 |
| `cds/web-v2-dist/` 不存在时 | server.ts 检测后 `console.warn` 并跳过挂载，老页面继续 work |
| 回滚 | `rm -rf cds/web-v2 cds/web-v2-dist` + revert server.ts diff，零下游影响 |

### Week 1 交付清单 ✅

- [x] Vite + React + TS + Tailwind + shadcn/ui 工程搭建
- [x] 主题切换（dark/light）通过 `[data-theme]` 属性 + token 双写
- [x] API proxy（开发模式走 `/api` → :9900；生产同源）
- [x] 4 个验证项 HelloPage 跑通（Tailwind/主题/API/Dialog）
- [x] Express `/v2/*` 挂载，零侵入老页面
- [x] 单测守卫 `/v2` 挂载 + `/api/factory-reset` 不被 shadow
- [x] 全量 tsc + test 绿灯

---

## 三、Week 2-5 路线图（下棒执行）

### Week 2：迁移 `cds-settings.html`（最简单的页面，先做）

**输入**：`cds/web/cds-settings.html`(389 行) + `cds/web/cds-settings.js`(477 行)，结构是 7 个 tab + 左侧 44px icon-nav

**目标**：
- 新增 `cds/web-v2/src/pages/CdsSettingsPage.tsx`
- 新增 `cds/web-v2/src/components/ui/tabs.tsx`（包装 `@radix-ui/react-tabs`）
- 把每个 tab 拆成独立组件 `src/pages/cds-settings/tabs/{General,Auth,GitHubApp,Cluster,Mirror,Webhook,Storage}Tab.tsx`
- 路由：`/v2/cds-settings`，加到 `src/App.tsx`
- API 调用全部走 `apiRequest()`，禁止裸 `fetch`

**验证**（按 `human-verify` 技能六步）：
1. 在 dark / light 两个主题下，每个 tab 都没有暗色背景泄漏
2. 每个 tab 的「保存」按钮成功后 → 后端 GET 验证已生效
3. 老 `/cds-settings.html` 仍可访问且 work（保留作为 escape hatch）
4. `pnpm build` 后 bundle 不超过 120 KB gzipped
5. 浏览器 console 零 warning（特别是 React hydration / proxy / CORS）
6. `/preview` 技能拿预览地址，让用户访问 `/v2/cds-settings` 验收

**预估工作量**：1.5 天

---

### Week 3：迁移 `settings.html` + `project-list.html`

**项目设置页**（`settings.html` 400 行 + `settings.js` 1973 行）：
- 路由：`/v2/settings/:projectId/*`（projectId 从 path 拿，禁止 `?project=` query）
- 复用 Week 2 的 `Tabs` 组件
- 项目级 RESTful API：`GET /api/projects/:id/...` 全部已就位
- 依赖：项目列表上下文 → 写一个 `useProject(id)` hook

**项目列表页**（`project-list.html` 1483 行 + `projects.js` 3046 行）：
- 路由：`/v2/project-list`
- 卡片组件：`<ProjectCard>`（参考 `cds/web/projects.js` 的 Railway 风格设计）
- 操作：创建 / 删除 / 进入 / GitHub link / 复制 token
- 每张卡片有一个固定的 dropdown menu（用 shadcn `<DropdownMenu>` 替代手写 popover）
- 最难的一块：**GitHub Device Flow 弹窗**（`cds/web/agent-key-modal.js` 731 行）→ 用 shadcn Dialog 重写

**预估工作量**：3 天

---

### Week 4：迁移 `index.html`（最大、最难）

**输入**：`cds/web/index.html` 286 行 + `cds/web/app.js` **13016 行** + 4 个独立 modal JS 文件

**结构拆分**：
- `BranchListLayout`（左 sidebar + 右 content area）
- `BranchCard`（单分支卡片，含 status / actions / quick toolbar）
- `TopologyView`（拓扑视图，建议用 React Flow，与 prd-admin 涌现探索器同款，可复用知识）
- 5 种弹窗 → 1 种 `<Dialog>`：
  - `settings-menu` → `<DropdownMenu>`（在 header 右上角）
  - `cds-user-popover` → `<Popover>`（点头像）
  - `config-modal` → `<Dialog>`（构建配置）
  - `topo-sys-popover` → `<Dialog>`（拓扑系统设置）
  - `agent-key-modal` → `<Dialog>`（已 Week 3 做掉）
- SSE 流处理：`useEventSource(url)` hook（订阅 `/api/branches/stream` + `/api/proxy-log/stream`）
- Bridge 操作面板：右下角 widget，调 `/api/bridge/command/:branchId`（端点见 `bridge-ops.md`）
- Activity Monitor：左上角面板，订阅 `/api/activity-stream`

**关键替换**：
- 全局 SSE EventSource 管理（`app.js` 里散落 4-5 处）→ 统一封装成 `useEventSource` + 自动断线重连 + `afterSeq` 续传
- 拓扑视图的 React Flow 配置必须遵守 `.claude/rules/gesture-unification.md`：`panOnScroll`, `zoomOnPinch`, `zoomActivationKeyCode=['Meta','Control']`, `zoomOnDoubleClick=false`

**预估工作量**：7-10 天（这是占总工作量 60% 的页面）

---

### Week 5：清理 + 切流

完成 Week 2-4 后：
1. 把 Express 的 SPA fallback 切到 v2：`/` 直接 redirect 到 `/v2/project-list`，老路径只保留 redirect
2. 在老页面顶部加 banner：「即将下线，请使用新版 → /v2」（保留 1 周）
3. 一周后删 `cds/web/`（保留 `favicon.svg` 和 `manifest.json`），重命名 `cds/web-v2/` → `cds/web/`，更新 server.ts 路径
4. 删 `cds/CLAUDE.md` 里 4 条已被 shadcn 兜住的 UI 规则：
   - 「按钮图标比例 ≥55%」 → cva variant 自动
   - 「Flex 折叠 min-height: 0」 → Radix collapsible 自动
   - 「主题 token 双写」 → tailwind config 一处
   - 「白天暗色背景」 → tokens 已 enforce
5. 删 `.claude/rules/cds-theme-tokens.md` 和 `.claude/rules/frontend-modal.md`（规则失效）
6. 保留 `scope-naming.md` `bridge-ops.md` `cds-auto-deploy.md` `quickstart-zero-friction.md`（业务规则）

**预估工作量**：2 天

**总工时预估**：14-16 天（含验收和返工 buffer）

---

## 四、迁移期间的硬约束

### 不能做的

- ❌ 不要给老 `cds/web/*.js` 加新功能（只 bug fix）
- ❌ 不要再写 `.claude/rules/cds-*-token.md` 这种 UI 规则（直接在新栈里规范）
- ❌ 不要直接改 `cds/web/style.css`
- ❌ 不要触碰 `POST /api/factory-reset` 路由（复活接口）
- ❌ 不要在新栈里用 `localStorage`（违反 `no-localstorage.md`）
- ❌ 不要在新栈里用 emoji（违反根 `CLAUDE.md` §0）
- ❌ 不要在新栈里写 `var(--xxx, #darkColor)` fallback（违反 `cds-theme-tokens.md`）

### 必须做的

- ✅ 业务 API（`cds/src/`）继续按需迭代，**不动迁移**
- ✅ 新功能直接写在 `cds/web-v2/src/`，**不要写**在老 `cds/web/`
- ✅ 每周交付一个完整页面（独立 commit），出问题 `git revert` 零 downtime
- ✅ 每个 PR 必须包含：
  1. 新页面的所有源码
  2. 至少一个 `cds/tests/` 集成测试覆盖核心路径
  3. `pnpm build` 后的 bundle size 报告（控制 < 500 KB gzipped）
  4. 在 dark + light 两主题下的截图（贴 PR 描述）
  5. `changelogs/` 碎片记录

---

## 五、关键决策记录

### 为什么是 React + Vite + Tailwind + shadcn/ui？

| 维度 | 当前 | 新栈 |
|------|------|------|
| 主题切换 | 每组件手动写 `:root / [data-theme="light"]` | `dark:` 类 + tokens 一处定义 |
| 弹窗 | 5 种实现各踩一遍坑 | shadcn `<Dialog>` 一个组件全用 |
| 按钮图标比例 | 手动检查 ≥55% | cva `size-*` variants 自动 |
| 与 prd-admin 一致性 | 完全两套 | **同栈**，代码可复用 |
| 文件组织 | 12k 行单文件 | 每页一个 `.tsx`，每组件 100-200 行 |

shadcn/ui 是源码 copy 进项目（不是 npm 黑盒），自己改样式不需要 wrap 第三方组件。这点是选 shadcn 而不是 MUI / Ant Design 的决定性原因。

### 为什么 v2 dist 输出到 `cds/web-v2-dist/`（项目根目录）而不是 `cds/web-v2/dist/`？

让回滚是单步：`rm -rf cds/web-v2-dist` 即可让 `/v2/*` 失效。Vite 默认输出到 `cds/web-v2/dist/` 会和源码混在一起，回滚时容易误删源码。

### 为什么 `installSpaFallback` 接受 `v2DirOverride` 参数？

测试需要在 `tmpDir` 里造一个假的 `web-v2-dist`，硬编码路径会使测试无法 isolate。生产调用方留 undefined，路径自动按 webDir 推算。

---

## 六、给下棒 AI 的执行提示

1. **先读这些文件**（按顺序）：
   - 本文（路线图）
   - `cds/CLAUDE.md`（CDS 模块规则速查）
   - `.claude/rules/cds-theme-tokens.md`（颜色规则）
   - `.claude/rules/frontend-modal.md`（弹窗 3 硬约束）
   - `cds/web-v2/src/pages/HelloPage.tsx`（参考实现）

2. **每页迁移的标准流程**：
   ```
   读老页 HTML+JS → 列 API 端点清单 → 拆组件树 → 写 React 版 →
   pnpm tsc --noEmit → pnpm build → 浏览器自测 dark+light →
   写测试 → /cds-deploy → /preview → /uat 真人验收
   ```

3. **遇到不确定**：
   - shadcn 组件用法 → https://ui.shadcn.com/docs/components/{name}
   - Radix primitives → https://www.radix-ui.com/primitives/docs
   - Tailwind 类 → https://tailwindcss.com/docs

4. **禁止做的事情（再次强调）**：
   - 不动 `POST /api/factory-reset`（复活接口）
   - 不删 `cds/web/`（直到 Week 5 切流完成）
   - 不写 emoji
   - 不用 `localStorage`
   - 不写 `var(--x, #darkColor)` fallback

5. **每完成一个页面，更新本文的「Week X」 章节标记 ✅，并在「七、进度日志」追加一行**。

---

## 七、进度日志

| 日期 | Phase | 提交者 | commit | 备注 |
|------|-------|--------|--------|------|
| 2026-04-27 | Week 1（基础设施 + Hello 验证） | Claude (Opus 4.7) | 待填 | 4 项验证全绿，860 tests pass |

---

## 八、相关文档

- `doc/rule.doc-naming.md` — doc/ 目录命名规则
- `cds/CLAUDE.md` — CDS 模块约束
- `.claude/rules/cds-theme-tokens.md` — 颜色 token 规则
- `.claude/rules/frontend-modal.md` — 弹窗 3 硬约束
- `.claude/rules/no-localstorage.md` — 禁用 localStorage
- `.claude/rules/zero-friction-input.md` — 输入零摩擦
- `.claude/rules/guided-exploration.md` — 引导性原则
