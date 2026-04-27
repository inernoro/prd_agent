# CDS (Cloud Dev Suite) 模块约束

> 独立的 Node/Express 分支预览部署工具，前端是原生 HTML/JS/CSS（不是 React）。  
> 所有代码在 `cds/` 目录下自洽。

---

## 🚨 0. 禁止 Emoji（最高优先级）

**CDS 任何输出（HTML、JS 字面量、按钮标签、tooltip、API 文案、commit message、文档）一律不允许 emoji 字符。**

替代：用 SVG icon（`cds/web/app.js` 里已有 `ICON.*` 注册表），或纯文字标签。

详见根 `CLAUDE.md` §0。违反一律 reject。

---

## 构建 & 运行

```bash
cd cds && ./exec_cds.sh init       # 首次：依赖自动安装 + 配置向导
cd cds && ./exec_cds.sh start      # 启动（build + nginx + daemon）
cd cds && ./exec_cds.sh restart    # 更新后重启
cd cds && pnpm tsc --noEmit        # 类型检查
```

前端改动（`cds/web/`）是静态文件，修改后刷新浏览器即可生效（无需 build）。

---

## 强制规则

### 0. 🚨 白天主题禁止出现任何暗色背景（最高优先级）

**反复被用户指出 10+ 次的问题**，不管写"终端风""代码感""某某大厂也这么做"都不是借口。

任何 modal、代码块、YAML 预览、SSE 日志、进度面板——**白天主题下**一律：

```
bg = 浅色 (如 var(--bg-terminal) = #efe7df in light)
color = 深色 (如 var(--text-primary) = 深棕)
```

硬性禁止（违反直接 reject）：

- `background: #0a0a0f` / `#0b0b10` / `#1f1d2b` 之类的字面量
- `color: #e8e8ec` / `#cbd5e1` / `#fff` 之类的字面量
- 在 `[data-theme="light"]` 块里把 `--bg-*` 定义成暗色

提交前检查清单见 `.claude/rules/cds-theme-tokens.md` 顶部。

### 0.1. API label 全量覆盖（Activity Monitor 必须可读）

CDS Dashboard 左上角 Activity Monitor 展示 AI/用户每一次 `/api/*` 调用。**每条 `/api/*` 路由必须在 `cds/src/server.ts` 的 `resolveApiLabel()` 里有中文 label**（通过 staticMap 精确命中，或 patterns 正则命中）。没有 label 的路由在面板上只显示裸 URL（如 `api/me`），用户看不懂 AI 在干啥。

**硬性要求**：
- 新增 `router.get/post/put/delete/patch('/xxx', ...)` 时，同步在 `resolveApiLabel()` 里加条目
- 启动时 `auditApiLabels(app)` 会扫遍 Express 路由表，对缺失 label 的路由打 `[api-label]` warning。CI / 本地开发时看到这个 warning 必须立刻补上
- `:param` 动态路由走 `patterns: Array<[RegExp, string]>`；纯静态路径走 `staticMap`

**命名风格**：中文动词开头，6 字以内最佳：
- ✅ `获取构建配置` / `列出远程分支` / `批准导入` / `停止分支服务`
- ❌ `build-profiles 查询` / `get remote branches` / `branches stop API`

### 1. 按钮图标尺寸（icon-to-button ratio ≥ 55%）

**这是 CDS 里反复出现的视觉 bug**：
按钮容器 36×36，里面塞个 14×14 的 SVG → 按钮看起来"空心"，图标"发虚"。

**硬规则**：

| 按钮外框 | 最小 SVG 尺寸 | 比例 |
|---------|--------------|-----|
| 28×28 (xs) | 16 | 57% |
| 32×32 | 18 | 56% |
| 36×36 (默认 `.icon-btn`) | 20 | 55% |
| 40×40 | 22 | 55% |
| 44×44 (touch target) | 24 | 54% |

**写按钮时先查表**，不要"16px 都能看清"就放 16px —— CSS 类里默认的 `.icon-btn svg { 20px }` 已经有规则，**新加 SVG 直接不要写 `width/height` inline，靠 class 继承默认**。

有特殊尺寸需求（比如 sidebar 缩略 icon）再用 `style="width:14px;height:14px"` 覆盖，**但必须同步调小容器**，保持 ≥55% 比例。

反面案例（真实发生，2026-04-22 用户第 9 次反馈）：
```html
<!-- ❌ 34px 按钮 + 18px svg = 53%，视觉上明显发虚 -->
<button class="cds-mobile-menu-btn" style="width:34px;height:34px">
  <svg width="18" height="18">...</svg>
</button>

<!-- ✅ 40px 按钮 + 22px svg = 55% -->
<button class="cds-mobile-menu-btn" style="width:40px;height:40px">
  <svg width="22" height="22">...</svg>
</button>
```

### 2. Flex 折叠容器必须 `min-height: 0`

Flex 子元素默认 `min-height: auto`，会阻止 `max-height: 0` 的收缩生效。
任何"展开/收起"的 flex 面板（侧栏、抽屉、手风琴）**必须**同时设：

```css
.collapsible {
  max-height: 0;
  min-height: 0;        /* ← 少了这行就永远收不下去 */
  overflow: hidden;
  transition: max-height 260ms;
}
.collapsible.open { max-height: 480px; }
```

详见 `.claude/rules/frontend-modal.md` 第 3 条。

### 3. 主题 token 双写 + 禁止暗色 fallback

所有 `--bg-*` / `--text-*` token 必须在 `cds/web/style.css` 的 `:root` 和 `[data-theme="light"]` **同时定义**。
禁止 `var(--x, #darkColor)` 这种兜底色——缺定义时直接 `transparent` 或不写 fallback。

详见 `.claude/rules/cds-theme-tokens.md`（含完整 token 表 + z-index 分层表）。

### 4. Bridge 操作（`cds/src/routes/bridge.ts`）

Agent 通过 CDS 操作用户浏览器的规范见 `.claude/rules/bridge-ops.md`：
- 端点 `POST /api/bridge/command/:branchId`（branchId 在 URL **不**在 body）
- 每条指令必须带 `description`（中文，用户可见）
- 登录后页面跳转用 `spa-navigate` 不用 `navigate`（避免 token 丢失）

---

## 目录结构

```
cds/
├── exec_cds.sh            # 唯一入口脚本（init/start/stop/restart/logs）
├── src/
│   ├── index.ts           # Express server 入口
│   ├── routes/            # REST API 路由（含 bridge / github webhook）
│   ├── services/          # 业务逻辑（WorktreeService、BranchScheduler…）
│   ├── executor/          # 远端执行器（embedded / remote）
│   ├── infra/             # Mongo/Redis 等基础设施管理
│   └── domain/            # 类型/状态机
├── web/                   # 前端静态资源（原生 HTML/JS/CSS）
│   ├── index.html         # 分支列表页（主页面）
│   ├── project-list.html  # 项目列表页
│   ├── app.js             # ~12k 行，分支页逻辑
│   ├── projects.js        # 项目列表页逻辑
│   ├── self-update.js     # CDS 系统更新弹窗
│   ├── agent-key-modal.js # Agent Key 授权弹窗
│   └── style.css          # ~7.5k 行
└── tests/                 # vitest 单测
```

---

## 相关规则速查

| 规则 | 触发范围 | 核心 |
|------|---------|------|
| `.claude/rules/cds-theme-tokens.md` | `cds/web/*.css`, 新 modal/弹窗 | token 双主题 + 禁暗色 fallback + z-index 表 |
| `.claude/rules/frontend-modal.md` | `cds/web/*.js` 里的 modal/浮层 | 3 硬约束：inline style 高度 + createPortal + `min-height: 0` |
| `.claude/rules/bridge-ops.md` | `cds/src/routes/bridge.ts` | URL path 位置 + description 必填 + spa-navigate |
| `.claude/rules/cds-auto-deploy.md` | 已 link GitHub 的项目 | push 即部署，不再手动 /cds-deploy |
| `.claude/rules/quickstart-zero-friction.md` | `exec_cds.sh` | 一键启动包办所有依赖 |
