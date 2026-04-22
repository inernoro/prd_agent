# CDS (Cloud Dev Suite) 模块约束

> 独立的 Node/Express 分支预览部署工具，前端是原生 HTML/JS/CSS（不是 React）。  
> 所有代码在 `cds/` 目录下自洽。

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
