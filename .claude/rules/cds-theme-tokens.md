# CDS 主题 Token 规则

> CDS 前端必须支持暗黑/白天主题切换。每次新组件被报"白天模式显示问题"，根因都在下面这几条反复出现的反模式上。本规则禁止它们。

---

## 🚨 最高原则（违反此条已被用户反复指出 10+ 次）

### 白天主题下禁止出现任何暗色背景

不管你心里觉得"这是终端风格"/"代码块应该黑底"/"某某网站就这么做"——**CDS 白天主题下任何 modal、弹窗、代码块、进度日志、YAML 预览、SSE 日志**一律走浅色底 + 深色字。

反模式（禁止）：

```js
// ❌ bg 硬编码暗色：白天直接砸黑
'background:#0a0a0f'
'background:#0b0b10'
'background:#1f1d2b'

// ❌ --bg-terminal 在 light 主题定义成暗色：白天还是黑底
[data-theme="light"] { --bg-terminal: #1f1d2b; }

// ❌ color 硬编码浅色：白天字浮不出来
'color:#e8e8ec'
'color:#cbd5e1'
'color:#fff'
```

正确姿势：

```js
// ✅ bg 和 color 同时走主题 token，两边自动翻转
'background:var(--bg-terminal);color:var(--text-primary)'

// ✅ --bg-terminal 在 light 主题也必须是浅色
[data-theme="light"] { --bg-terminal: #efe7df; }  // 同 --bg-base
```

**检查清单（每个新 modal/弹窗提交前必过）**：

- [ ] 搜 `#0a0a0f / #0b0b10 / #1f1d2b / #0f1419` 等暗色字面量，是否在样式里出现
- [ ] 搜 `#e8e8ec / #cbd5e1 / #ffffff / #fff` 等浅色字面量，是否写死在 color 上
- [ ] 点主题切换按钮（右上角 🌙），确认组件**两个主题都能正常看清**
- [ ] 如果一个值只在一种主题下合适，说明用错了——所有颜色都应该通过 token 自动翻转

**"终端风"不是暗色的借口**。白天的代码块 = 浅底深字，照样能看清，照样专业（GitHub/Stripe/Vercel 全是这么做的）。

---

## 强制规则

### 1. 任何 `var(--xxx, #fallback)` 中的 fallback 必须是中性色

JS 内联样式或 CSS 里出现：

```js
// ❌ 禁止：fallback 是暗色，--xxx 缺定义时永远走暗色，白天模式破
'background:var(--bg-base,#0b0b10)'

// ❌ 同样禁止：fallback 是任何主题特定的颜色
'color:var(--text-primary,#e8e8ec)'
```

**正确做法之一**：
```js
// ✅ 不写 fallback —— 缺定义时直接 transparent / inherit / 无效，bug 立刻可见
'background:var(--bg-base)'
```

**正确做法之二**：fallback 必须用「主题中性色」，例如纯透明、`currentColor`、`inherit`：
```js
'background:var(--bg-base,transparent)'
```

### 2. 新增任何 `--bg-*` token 必须在 `:root` 和 `[data-theme="light"]` 同时定义

`cds/web/style.css` 的 `:root { ... --bg-base: ... }` 和 `[data-theme="light"] { ... --bg-base: ... }` 是 SSOT（双胞胎块）。新增 token 时**必须同时编辑两块**，不能只加 dark 一边。

当前已建立的 token 对：

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

写新 modal 之前 grep 确认要用的 token 在 `style.css` 同时存在于 dark 和 light 主题。如果不存在，先去定义，再写组件。**禁止**临时写 `var(--myThing, #color)` 跑路。

### 4. z-index 分层必须查表，不能拍脑袋

CDS 弹窗有多层（modal、dropdown、restart overlay、toast）。新增弹窗前查这张表，不要随便写一个数字让自己和别的弹窗打架：

| 层 | z-index 范围 | 实例 |
|---|---|---|
| 普通悬浮（tooltip / popover） | `100 ~ 999` | settings menu, branch dropdown |
| 内容浮层（侧边抽屉） | `1000 ~ 4999` | activity monitor (9998 历史值，已收敛) |
| 模态遮罩 backdrop | `9000 ~ 9999` | （已不再使用 9000 段，改 10000+） |
| 模态 modal/dialog | `10000 ~ 10049` | self-update modal (10000), agent-key modal (10000) |
| 模态内嵌 popover | `10050 ~ 10099` | self-update branch dropdown (10010) |
| 全局 critical overlay | `10050+` | `cds-restart-overlay` (10050)，覆盖一切 modal |
| Toast | `99999` | 顶级，不参与 modal 排序 |

**判定**：你的弹窗"必须能盖在所有 modal 之上"才用 10050+，否则用 10000~10049。

---

## 测试要求

任何改动 modal/弹窗/`background`/`color` 的 PR，**必须**：

1. 在白天 + 黑夜两种主题下各开一次该弹窗
2. 截图比对，确认背景/文字/边框对比度合理
3. 不允许"我只在黑夜模式下测过"就提交

CDS 在 header 右上角的 🌙 按钮可一键切换主题，没有借口。

---

## 历史背景

> 2026-04-22 用户反馈"暗黑/白天反复调试，如何一劳永逸"——根因是过去三个月新加的 modal 都习惯写 `var(--bg-base, #0b0b10)`，token 在 :root 没定义时永远走暗色 fallback，白天主题永远是黑底。本规则的目标是把这条隐形坑显式化。

## 相关文件

- `cds/web/style.css` :root + [data-theme="light"] 块
- `.claude/rules/frontend-modal.md` — 前端模态布局 3 硬约束
