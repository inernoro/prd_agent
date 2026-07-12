# prd-admin 系统级双皮肤（Dual Theme）

> 触发：编辑 `prd-admin/src/**/*.tsx`、`prd-admin/src/styles/*.css`。
> 一句话：**颜色只能来自 token 或双皮肤分支，禁止裸写**。tokens.css 的暗/浅双主题早已齐备，
> 历史上所有「白底浮暗卡」「浅色下表面隐形」问题的根因都是组件绕过 token 硬编码颜色。

---

## 一、机制（三层，2026-07-12 落地）

| 层 | 是什么 | SSOT |
|---|---|---|
| Token 层 | 暗色 `:root` + 浅色 `[data-theme="light"]` 双写的全量语义 token | `prd-admin/src/styles/tokens.css` |
| 应用层 | 移动端全局偏好 `mobileThemeStore`（暗色默认，首页可切换），AppShell 按「偏好 + 路由」落 `<html data-theme>` | `src/stores/mobileThemeStore.ts` + `src/layouts/AppShell.tsx` |
| 守卫层 | **硬编码棘轮**：每个文件的白透明/深色 hex 数量只许减不许增，CI fail | `src/lib/__tests__/themeHardcodeRatchet.test.ts` + `themeHardcodeBaseline.json` |

## 二、写 UI 时的硬规则

1. **新代码零新增硬编码**。棘轮测试会拦：`rgba(255,255,255,x)` 与感知亮度 < 0.15 的 hex 字面量，任何文件超出基线即 CI fail。
2. **修法映射表**（把硬编码换成什么）：

| 硬编码 | 换成 |
|---|---|
| `background: rgba(255,255,255,0.05~0.12)` | `var(--bg-card)` / `var(--bg-secondary)` / `var(--bg-tertiary)` |
| `border: 1px solid rgba(255,255,255,0.06~0.18)` | `var(--border-secondary)` / `var(--border-subtle)` / `var(--border-default)` |
| `color: #fff` / `rgba(255,255,255,0.x)` 文字 | `var(--text-primary)` / `var(--text-secondary)` / `var(--text-muted)` |
| `background: #0f1014` 这类深底 | `var(--bg-base)` / `var(--bg-elevated)` / `var(--panel-solid)` |
| App Store 版式（iOS 复刻页） | `useAppStoreColors()`（暗=AS_COLOR，浅=AS_COLOR_LIGHT，`src/hooks/useAppStoreColors.ts`） |
| 一个页面确需两套完整皮肤对象 | `useDataTheme()`（`src/hooks/useDataTheme.ts`）+ 皮肤对象分支（参考 `MobileHomePage.tsx` 的 LIGHT_SKIN/DARK_SKIN） |
| CSS 文件里的暗色规则 | 同文件补 `[data-theme="light"] .xxx { ... }` 覆盖（参考 surface.css 的 mkt-card 系列） |

3. **合法例外**（不用改，也解释了为什么棘轮不是零容忍）：彩色渐变/封面图上的白字白底（两主题都成立）、暗色形态专用皮肤对象里的深色值、`data-theme` 已被页面钉死的纸面页（米多早报）。例外只能维持基线，不能推高基线。
4. **基线更新**：确属合法例外需要提高某文件计数时，跑
   `UPDATE_THEME_BASELINE=1 pnpm vitest run src/lib/__tests__/themeHardcodeRatchet.test.ts`
   基线 diff 必须出现在 PR 里并说明原因；无说明的基线上调一律 reject。
5. **清扫顺序**（存量债务，台账见 `doc/debt.frontend.mobile-light-theme.md`）：用户走到哪修到哪；优先级 = 移动端 Tab 直达页 > 高频 Agent 页 > 管理后台深页。

## 三、验收要求

改动任何带颜色的 UI，交付前必须两个主题各看一眼（移动端首页右上角按钮即可切换）；只在单主题下测过的 UI 不许声称完成（同 cds-theme-tokens.md 的纪律）。

## 四、历史背景

2026-07-12 用户在浅色主题下打开海鲜市场，半高密度卡的信息板是硬编码 `rgba(8,12,22,0.9)` 深色渐变、无浅色覆盖，整页「白底浮暗卡」；此前底部 TabBar、百宝箱移动版也因同类硬编码逐个返工。用户提出「做一个系统级的双皮肤，从根上解决这类问题」。本规则与棘轮测试同 PR 落地：token 早已齐备，根治手段是**让绕过 token 的行为在 CI 里现形**。
