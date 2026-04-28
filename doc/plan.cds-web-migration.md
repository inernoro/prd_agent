# CDS Web 前端迁移计划与交接

> **类型**：plan（实施计划） | **状态**：基础设施 + 大重命名已完成，Week 2-5 逐页迁移待执行
> **作者**：Claude (Opus 4.7) · **更新**：2026-04-28
> **下棒**：可委托其他 AI / 开发者按本文 Week 2-5 路线图继续

---

## 一、为什么做这件事（30 秒读懂）

CDS 当前前端是 12k 行 `app.js` + 7.5k 行 `style.css` 的原生 HTML/JS/CSS 项目，每个新弹窗都要重写一遍：portal、focus trap、ESC 键、`min-h-0`、白天暗色 fallback、emoji 渗漏、`var(--xxx, #fallback)` 兜底色、按钮图标比例。最近 3 个月用户在同一类问题上反复反馈 10+ 次。

**根因**：没有组件抽象层，所有视觉规则都靠 markdown 规则文档手动 enforce。规则越多 → 漏掉的越多 → 越反复调试。

**方案**：把 4 个 HTML 页面（`cds-settings` / `settings` / `project-list` / `index`）渐进式迁移到 React + Vite + TypeScript + Tailwind + shadcn/ui。新栈与 prd-admin 同栈，可复用知识与代码。**URL 永远干净**——每个页面用最直观的语义路径（`/cds-settings` / `/projects` / `/settings/:id`），不带任何过渡期前缀。

---

## 二、当前架构（基础设施 + 大重命名后的状态）

### 目录布局

```
cds/
├── src/                    # Express 后端
│   └── server.ts          # 路由 + installSpaFallback + MIGRATED_REACT_ROUTES
├── web/                   # ★ React 工程（Vite + TS + Tailwind + shadcn/ui）
│   ├── src/
│   │   ├── App.tsx        # BrowserRouter（无 basename）
│   │   ├── pages/HelloPage.tsx
│   │   ├── components/ui/ # shadcn 组件（Button / Card / Dialog ...）
│   │   └── lib/           # api / theme / utils
│   ├── package.json
│   ├── vite.config.ts     # base: '/', outDir: './dist'
│   └── dist/              # 构建产物（gitignored）
└── web-legacy/            # 老的原生 HTML/JS/CSS（逐页迁移完后整体删除）
    ├── index.html         # 分支列表（待迁）
    ├── project-list.html  # 项目列表（待迁）
    ├── settings.html      # 项目设置（待迁）
    ├── cds-settings.html  # CDS 系统设置（待迁）
    └── ...
```

### URL 路由的三层结构

server.ts 的 `installSpaFallback()` 维护三层优先级，由高到低：

| 优先级 | 范围 | 谁负责 |
|------|------|------|
| 1 | `/api/**` | Express 后端路由（包括 `POST /api/factory-reset` 复活接口） |
| 2 | React 已迁移路由 + `/assets/**` | `cds/web/dist/` 静态服务，路由清单是 `MIGRATED_REACT_ROUTES`（目前 `['/hello']`） |
| 3 | 老路径（`/`、`/project-list`、`/cds-settings.html` 等） | `cds/web-legacy/` 静态文件 + SPA fallback |

每迁移一个页面 = 在 `MIGRATED_REACT_ROUTES` 加一行 + 在 `cds/web/src/App.tsx` 加一个 `<Route>` + 通常会同步删一份 legacy 文件。每次合入互不影响，零 downtime。

### 边界保证

| 受保护对象 | 保证机制 |
|-----------|----------|
| `POST /api/factory-reset`（复活接口） | `/api/*` 永远在 React + legacy 之上，`server-integration.test.ts` 集成测试守卫 |
| 未迁移的老页面 | 路径不在 `MIGRATED_REACT_ROUTES` 时 100% 走 `cds/web-legacy/` |
| React 构建产物缺失 | `installSpaFallback` 检测 `dist/index.html` 不存在时 warn + 跳过，老页面继续 work |
| 回滚 | 单个迁移：`git revert` 一个 commit；整体：`git mv cds/web cds/web-react && git mv cds/web-legacy cds/web` |

### 已完成基础设施清单

- [x] Vite 5 + React 18 + TS 5.6 + Tailwind 3.4 + Radix UI primitives
- [x] 主题切换（dark / light）通过 `[data-theme]` 属性 + token 双写
- [x] API proxy（开发模式 `/api` → `localhost:9900`；生产同源）
- [x] HelloPage 4 项验证（Tailwind / 主题 / API / Dialog）
- [x] Express 三层路由（`/api/*` / React 已迁移 / legacy fallback）
- [x] 集成测试守卫迁移路由 + 复活接口不被 shadow
- [x] `exec_cds.sh build_web` 自动 SHA 缓存（HEAD 没动则跳过）
- [x] 大重命名：`cds/web/` = React 工程；`cds/web-legacy/` = 老前端；URL 无 `/v2` 前缀

---

## 三、Week 2-5 路线图（下棒执行）

### Week 2：迁移 `cds-settings.html`（最简单的页面，先做）

**输入**：`cds/web-legacy/cds-settings.html`（389 行）+ `cds/web-legacy/cds-settings.js`（477 行），结构是 7 个 tab + 左侧 44px icon-nav

**目标**：
- 新增 `cds/web/src/pages/CdsSettingsPage.tsx`
- 新增 `cds/web/src/components/ui/tabs.tsx`（包装 `@radix-ui/react-tabs`）
- 把每个 tab 拆成独立组件 `src/pages/cds-settings/tabs/{General,Auth,GitHubApp,Cluster,Mirror,Webhook,Storage}Tab.tsx`
- 路由：`/cds-settings`，加到 `src/App.tsx` + `MIGRATED_REACT_ROUTES`
- API 调用全部走 `apiRequest()`，禁止裸 `fetch`
- **删除 legacy**：`cds/web-legacy/cds-settings.html` + `cds-settings.js` 同 PR 删除

**验证**（按 `human-verify` 技能六步）：
1. dark / light 两个主题下，每个 tab 都没有暗色背景泄漏
2. 每个 tab 的「保存」按钮成功后 → 后端 GET 验证已生效
3. `pnpm build` 后 bundle 不超过 120 KB gzipped
4. 浏览器 console 零 warning（特别是 React hydration / proxy / CORS）
5. `/preview` 技能拿预览地址，让用户访问 `/cds-settings` 验收
6. 复活接口（系统设置 maintenance tab 的「恢复出厂」按钮）调用后 `POST /api/factory-reset` 仍可达

**预估工作量**：1.5 天

---

### Week 3：迁移 `settings.html` + `project-list.html`

**项目设置页**（`web-legacy/settings.html` 400 行 + `settings.js` 1973 行）：
- 路由：`/settings/:projectId/*`（projectId 从 path 拿，禁止 `?project=` query）
- 复用 Week 2 的 `Tabs` 组件
- 项目级 RESTful API：`GET /api/projects/:id/...` 全部已就位
- 写一个 `useProject(id)` hook 集中拉项目元数据

**项目列表页**（`web-legacy/project-list.html` 1483 行 + `projects.js` 3046 行）：
- 路由：`/projects`（更直观，老 `/project-list` 加 redirect 到新路径）
- 卡片组件：`<ProjectCard>`（参考 `web-legacy/projects.js` 的 Railway 风格设计）
- 操作：创建 / 删除 / 进入 / GitHub link / 复制 token
- 每张卡片有一个固定的 dropdown menu（用 shadcn `<DropdownMenu>` 替代手写 popover）
- 最难的一块：**GitHub Device Flow 弹窗**（`web-legacy/agent-key-modal.js` 731 行）→ 用 shadcn Dialog 重写

**预估工作量**：3 天

---

### Week 4：迁移 `index.html`（最大、最难）

**输入**：`web-legacy/index.html` 286 行 + `web-legacy/app.js` **13016 行** + 4 个独立 modal JS 文件

**结构拆分**：
- 路由：`/branches/:projectId`（取代老 `/branch-list?project=xxx` query 写法）
- `BranchListLayout`（左 sidebar + 右 content area）
- `BranchCard`（单分支卡片，含 status / actions / quick toolbar）
- `TopologyView`（拓扑视图，建议用 React Flow，与 prd-admin 涌现探索器同款）
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
1. `MIGRATED_REACT_ROUTES` 长度等于全部业务路由，老 `/` redirect 改为直接 React `/`（取代 `web-legacy/index.html`）
2. 删 `cds/web-legacy/` 整个目录（保留 `favicon.svg` 移到 `cds/web/public/`）
3. server.ts 删 legacy 静态 mount + SPA fallback 第二层（只剩 React + `/api/*`）
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

- 不要给 `cds/web-legacy/*.js` 加新功能（只 bug fix）
- 不要再写 `.claude/rules/cds-*-token.md` 这种 UI 规则（直接在新栈里规范）
- 不要直接改 `cds/web-legacy/style.css`
- 不要触碰 `POST /api/factory-reset` 路由（复活接口）
- 不要在 `cds/web/` 用 `localStorage`（违反 `no-localstorage.md`）
- 不要在 `cds/web/` 用 emoji（违反根 `CLAUDE.md` §0）
- 不要在 `cds/web/` 写 `var(--xxx, #darkColor)` fallback（违反 `cds-theme-tokens.md`）
- 不要重新引入 `/v2/` 之类的 URL 前缀——干净 URL 是这个项目的核心承诺

### 必须做的

- 业务 API（`cds/src/`）继续按需迭代，**不动迁移**
- 新功能直接写在 `cds/web/src/`，**不要写**在 `cds/web-legacy/`
- 每周交付一个完整页面（独立 commit），出问题 `git revert` 零 downtime
- 每个 PR 必须包含：
  1. 新页面的所有源码
  2. 在 `MIGRATED_REACT_ROUTES` 加一行
  3. 同 PR 删 `cds/web-legacy/<对应文件>`
  4. 至少一个 `cds/tests/` 集成测试覆盖核心路径
  5. `pnpm build` 后的 bundle size 报告（控制 < 500 KB gzipped）
  6. 在 dark + light 两主题下的截图（贴 PR 描述）
  7. `changelogs/` 碎片记录

---

## 五、关键决策记录

### 为什么是 React + Vite + Tailwind + shadcn/ui？

| 维度 | 老栈 | 新栈 |
|------|------|------|
| 主题切换 | 每组件手动写 `:root / [data-theme="light"]` | `dark:` 类 + tokens 一处定义 |
| 弹窗 | 5 种实现各踩一遍坑 | shadcn `<Dialog>` 一个组件全用 |
| 按钮图标比例 | 手动检查 ≥55% | cva `size-*` variants 自动 |
| 与 prd-admin 一致性 | 完全两套 | **同栈**，代码可复用 |
| 文件组织 | 12k 行单文件 | 每页一个 `.tsx`，每组件 100-200 行 |

shadcn/ui 是源码 copy 进项目（不是 npm 黑盒），自己改样式不需要 wrap 第三方组件。这点是选 shadcn 而不是 MUI / Ant Design 的决定性原因。

### 为什么用 `MIGRATED_REACT_ROUTES` 显式枚举，而不是 React 接管整个根路径？

如果 React 直接接管 `/`，未迁移的页面（`/cds-settings.html`、`/project-list.html` 等）就需要 React 的 router 知道它们是"应该 fallback 到 legacy"的特殊路径——这把决策从服务器拉到了客户端，需要双向同步。

显式列表保留了「服务器是路由权威」的清晰边界：每迁移一个页面，加一行就接管；不在列表里的就走 legacy。Week 5 切流时，列表加上 `/` 等通配，legacy 整体退场。

### 为什么 `cds/web/` 是 React 而 `cds/web-legacy/` 是老前端，不是反过来？

「`cds/web/`」永远代表「当前的 web 应用」。半年后的开发者不需要记得"v2"是什么、"为什么有两个 web 目录"——他们只需要知道：默认在 `web/` 里写代码，`web-legacy/` 是临时存活的迁移过渡。Week 5 删除 `web-legacy/` 后只剩一个 `web/`，没有任何"versioned naming"残留。

### 为什么 React build 输出在 `cds/web/dist/`（Vite 默认）而不是 `cds/web-dist/`？

之前过渡阶段把 dist 放到外部目录是为了"单步回滚"。重命名到 `cds/web/` 后，回滚单位变成单个迁移 commit（`git revert`），dist 跟随 `web/` 走 Vite 默认布局最自然，`.gitignore` 的全局 `dist/` 通配自动覆盖。

---

## 六、给下棒 AI 的执行提示

1. **先读这些文件**（按顺序）：
   - 本文（路线图）
   - `cds/CLAUDE.md`（CDS 模块规则速查）
   - `.claude/rules/cds-theme-tokens.md`（颜色规则）
   - `.claude/rules/frontend-modal.md`（弹窗 3 硬约束）
   - `cds/web/src/pages/HelloPage.tsx`（参考实现）

2. **每页迁移的标准流程**：
   ```
   读老页 HTML+JS → 列 API 端点清单 → 拆组件树 → 写 React 版 →
   pnpm tsc --noEmit → pnpm build → 浏览器自测 dark+light →
   写测试 → /cds-deploy → /preview → /uat 真人验收 →
   把对应 web-legacy/ 文件删掉，加进 MIGRATED_REACT_ROUTES
   ```

3. **遇到不确定**：
   - shadcn 组件用法 → https://ui.shadcn.com/docs/components/{name}
   - Radix primitives → https://www.radix-ui.com/primitives/docs
   - Tailwind 类 → https://tailwindcss.com/docs

4. **禁止做的事情（再次强调）**：
   - 不动 `POST /api/factory-reset`（复活接口）
   - 不删 `cds/web-legacy/`（直到 Week 5 切流完成）
   - 不写 emoji
   - 不用 `localStorage`
   - 不写 `var(--x, #darkColor)` fallback
   - 不引入 `/v2/` 之类的 URL 前缀

5. **每完成一个页面，更新本文「Week X」 章节标记完成，并在「七、进度日志」追加一行**。

---

## 七、进度日志

| 日期 | Phase | 提交者 | commit | 备注 |
|------|-------|--------|--------|------|
| 2026-04-27 | 基础设施（Vite + React + Tailwind + HelloPage） | Claude (Opus 4.7) | 2017eb9 → PR #515 | 4 项验证全绿，860 tests pass，`/v2/*` 前缀挂载 |
| 2026-04-28 | 大重命名（`web/` ↔ `web-legacy/`，去 `/v2/`） | Claude (Opus 4.7) | 待填 | URL 永远干净，`MIGRATED_REACT_ROUTES` 显式枚举 |

---

## 八、相关文档

- `doc/rule.doc-naming.md` — doc/ 目录命名规则
- `cds/CLAUDE.md` — CDS 模块约束
- `.claude/rules/cds-theme-tokens.md` — 颜色 token 规则
- `.claude/rules/frontend-modal.md` — 弹窗 3 硬约束
- `.claude/rules/no-localstorage.md` — 禁用 localStorage
- `.claude/rules/zero-friction-input.md` — 输入零摩擦
- `.claude/rules/guided-exploration.md` — 引导性原则
