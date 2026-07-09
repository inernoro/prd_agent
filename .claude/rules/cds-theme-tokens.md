# CDS 主题 Token 规则

> CDS 前端必须支持暗黑/白天主题切换。每次新组件被报"白天模式显示问题"，根因都在下面这几条反复出现的反模式上。本规则禁止它们。
>
> **Token SSOT 有两处（双栈并存，2026-07-09 更正）**：
> - **新栈** `cds/web/src/index.css`：shadcn 方案，token 是 **HSL 三元组**（如 `--card: 240 4% 12%`），定义在 `[data-theme='dark']` 与 `[data-theme='light']` 双块。
> - **legacy 栈** `cds/web-legacy/style.css`：完整颜色值 token（`--bg-*` / `--text-*`），定义在 `:root` 与 `[data-theme="light"]` 双块。
>
> 旧版本规则曾指向 `cds/web/style.css`——该文件已不存在，按旧路径找 token 会扑空或误建第三份源。

---

## 最高原则（违反此条已被用户反复指出 10+ 次）

### 白天主题下禁止出现任何暗色背景

不管你心里觉得"这是终端风格"/"代码块应该黑底"/"某某网站就这么做"——**CDS 白天主题下任何 modal、弹窗、代码块、进度日志、YAML 预览、SSE 日志**一律走浅色底 + 深色字。

反模式（禁止）：

```js
// 错误：bg 硬编码暗色，白天直接砸黑
'background:#0a0a0f'
'background:#0b0b10'
'background:#1f1d2b'

// 错误：--bg-terminal 在 light 主题定义成暗色，白天还是黑底
[data-theme="light"] { --bg-terminal: #1f1d2b; }

// 错误：color 硬编码浅色，白天字浮不出来
'color:#e8e8ec'
'color:#cbd5e1'
'color:#fff'
```

正确姿势：

```js
// 正确：bg 和 color 同时走主题 token，两边自动翻转
'background:var(--bg-terminal);color:var(--text-primary)'

// 正确：--bg-terminal 在 light 主题也必须是浅色
[data-theme="light"] { --bg-terminal: #efe7df; }  // 同 --bg-base
```

**检查清单（每个新 modal/弹窗提交前必过）**：

- [ ] 搜 `#0a0a0f / #0b0b10 / #1f1d2b / #0f1419` 等暗色字面量，是否在样式里出现
- [ ] 搜 `#e8e8ec / #cbd5e1 / #ffffff / #fff` 等浅色字面量，是否写死在 color 上
- [ ] 点主题切换按钮，确认组件**两个主题都能正常看清**
- [ ] 如果一个值只在一种主题下合适，说明用错了——所有颜色都应该通过 token 自动翻转

**"终端风"不是暗色的借口**。白天的代码块 = 浅底深字，照样能看清，照样专业（GitHub/Stripe/Vercel 全是这么做的）。

---

## 强制规则

### 0. 新栈 token 是 HSL 三元组，引用必须 `hsl(var(--x))` 包裹（2026-07-09 新增，真实事故）

`cds/web/src/index.css` 的 token 值是 **HSL 三元组**（`--card: 240 4% 12%`），不是完整颜色。裸写 `var(--card)` 解析出的是非法颜色值，**整条 CSS 属性在 computed-value 阶段失效**——而且因为 token 有定义，`var()` 的 fallback 也不会触发，错误静默发生。

```js
// 错误（真实事故：全局错误 Toast 双主题下都没有背景）
'background: var(--card, #1E1F20)'      // --card 已定义 → fallback 不触发 → 属性整体失效

// 正确
'background: hsl(var(--card))'
'border: 1px solid hsl(var(--destructive) / 0.45)'   // 带透明度写法
```

Tailwind 类（`bg-card` / `text-destructive`）内部已包 `hsl()`，直接用类最安全；只有 inline style 需要手写时才自己包。legacy 栈的 `--bg-*` token 是完整颜色值，不适用本条。

### 1. 任何 `var(--xxx, #fallback)` 中的 fallback 必须是中性色

JS 内联样式或 CSS 里出现：

```js
// 错误：fallback 是暗色，--xxx 缺定义时永远走暗色，白天模式破
'background:var(--bg-base,#0b0b10)'

// 同样错误：fallback 是任何主题特定的颜色
'color:var(--text-primary,#e8e8ec)'
```

**正确做法之一**：
```js
// 不写 fallback —— 缺定义时直接 transparent / inherit / 无效，bug 立刻可见
'background:var(--bg-base)'
```

**正确做法之二**：fallback 必须用「主题中性色」，例如纯透明、`currentColor`、`inherit`：
```js
'background:var(--bg-base,transparent)'
```

### 2. 新增任何 token 必须在两个主题块同时定义

- 新栈：`cds/web/src/index.css` 的 `[data-theme='dark']` 与 `[data-theme='light']` 双块。
- legacy 栈：`cds/web-legacy/style.css` 的 `:root` 与 `[data-theme="light"]` 双块。

新增 token 时**必须同时编辑两块**，不能只加 dark 一边。

legacy 栈已建立的 `--bg-*` token 对：

| Token | 用途 | dark | light |
|---|---|---|---|
| `--bg-primary` | 页面底色 | `#131314` | `#f8f2ed` |
| `--bg-card` | 卡片表面 | `#1E1F20` | `#ffffff` |
| `--bg-elevated` | 悬浮表面（菜单/弹窗 elevated） | `#282A2C` | `#f1eae4` |
| `--bg-input` | 表单输入背景 | `#1E1F20` | `#ffffff` |
| `--bg-base` | 子区域更深底（progress/sub-panel） | `#0b0b10` | `#efe7df` |
| `--bg-terminal` | 终端/代码块（白天也保留暗色但软化） | `#0f1419` | `#1f1d2b` |
| `--bg-code-block` | inline `<code>` | `rgba(255,255,255,0.06)` | `#2a1f190f` |

新增任何 `--bg-xxx` 必须按这个表格补一行 + 同时改两个 selector 块。

### 3. JS 创建的 modal/弹窗内联样式必须只引用已定义的 token

写新 modal 之前 grep 确认要用的 token 在对应 SSOT 文件里同时存在于 dark 和 light 主题。如果不存在，先去定义，再写组件。**禁止**临时写 `var(--myThing, #color)` 跑路。

### 4. z-index 分层必须查表，不能拍脑袋

新增弹窗前查表，不要随便写一个数字让自己和别的弹窗打架。**双栈各有一张表，别混用**。

**新栈 `cds/web/`（React，2026-07-09 收敛后的现行刻度）**：

| 带 | z-index 范围 | 用途 / 实例 |
|---|---|---|
| 局部堆叠 | `0 ~ 40` | 卡片内 absolute popover、sticky 表头（只在局部 stacking context 内比大小） |
| 模态基准 | `50` | shadcn Dialog、BranchDetailDrawer、页面级 toast |
| 全屏面板 | `60 ~ 100` | CommandPalette (60)、部署全屏 (80)、工作台 / 移动端抽屉 (90)、运维面板 / 报告全屏 viewer (100) |
| 全局悬浮 chrome | `120 ~ 220` | 更新徽章 (150/200)、CommitInbox (190)、confirm-action (200)、站内通知 (220) |
| portal 顶层 | `300` | `ui/dropdown-menu` 及所有 createPortal 浮层——必须高于一切模态/抽屉，保证从任何容器内打开都可见 |
| 遗留豁免 | `99999` | 仅 App.tsx chunk-load 错误 Toast，**不许新增** |

已知取舍：报告页移动端目录抽屉降到 90 后，若未来在抽屉内打开 Dialog(50) 会被抽屉盖住——出现该需求时把 Dialog 场景改为独立路由或提升该 Dialog，不要回头抬高抽屉。

**legacy 栈 `cds/web-legacy/`**：

| 层 | z-index 范围 | 实例 |
|---|---|---|
| 普通悬浮（tooltip / popover） | `100 ~ 999` | settings menu, branch dropdown |
| 内容浮层（侧边抽屉） | `1000 ~ 4999` | activity monitor (9998 历史值，已收敛) |
| 模态 modal/dialog | `10000 ~ 10049` | self-update modal (10000), agent-key modal (10000) |
| 模态内嵌 popover | `10050 ~ 10099` | self-update branch dropdown (10010) |
| 全局 critical overlay | `10050+` | `cds-restart-overlay` (10050)，覆盖一切 modal |
| Toast | `99999` | 顶级，不参与 modal 排序 |

---

## 测试要求

任何改动 modal/弹窗/`background`/`color` 的 PR，**必须**：

1. 在白天 + 黑夜两种主题下各开一次该弹窗
2. 截图比对，确认背景/文字/边框对比度合理
3. 不允许"我只在黑夜模式下测过"就提交

CDS header 有主题切换按钮可一键切换主题，没有借口。

---

## 历史背景

> 2026-04-22 用户反馈"暗黑/白天反复调试，如何一劳永逸"——根因是过去三个月新加的 modal 都习惯写 `var(--bg-base, #0b0b10)`，token 在 :root 没定义时永远走暗色 fallback，白天主题永远是黑底。本规则的目标是把这条隐形坑显式化。
>
> 2026-07-09 四维扫描更正：token SSOT 从已不存在的 `cds/web/style.css` 改为双栈两处；补第 0 条「HSL 三元组必须 hsl() 包裹」（App.tsx Toast 真实事故）；新栈 z-index 刻度表随 dropdown 10100 被抽屉 11000 遮挡的真实 bug 一并收敛落表。

## 相关文件

- `cds/web/src/index.css` — 新栈 token SSOT（`[data-theme='dark']` + `[data-theme='light']` 双块，HSL 三元组）
- `cds/web-legacy/style.css` — legacy 栈 token SSOT（`:root` + `[data-theme="light"]` 双块）
- `cds/web/tailwind.config.js` — Tailwind 语义色 → token 的映射
- `.claude/rules/frontend-modal.md` — 前端模态布局 3 硬约束
