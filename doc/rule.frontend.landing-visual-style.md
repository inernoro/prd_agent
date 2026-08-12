# 首页与登录页视觉语言 · 规则

> **版本**：v2.0 | **日期**：2026-08-06 | **状态**：已落地

**一句话**：对外展示类页面的视觉契约：一种签名渐变、一套标签规格、一套玻璃卡配方，都不许就地自造。
**谁该读**：改首页、登录页或任何对外页面的前端工程师与设计。
**读完能做什么**：按硬规则检查自己的页面有没有自造颜色或样式，并找到该复用的零件。

---

> **范围**：`prd-admin/src/pages/home/` + 所有对外展示类页面（登录、分享、落地、订阅邮件 H5 等）。
> **权威出处**：PR inernoro/prd_agent#405（`claude/redesign-homepage-gTSAf`），把 /home 从"粒子堆 + 代理卡片秀"重做成 Linear.app × Retro-Futurism 融合的九幕叙事。
> **维护原则**：每次更新整页替换，不保留历史变更记录（历史由 git + changelogs 承担）。

## 一、风格定位：Linear × Retro-Futurism

一句话：**Linear.app 的克制排版 + 80 年代 Synthwave / Tron 的冷光装饰**。

- Linear.app 的骨架：极窄字距、静态背景、滚动 fade-up、单一长景、大量留白
- Retro-Futurism 的点缀：HUD 终端 chip、CRT 扫描线、Synthwave 地平线、Tron 透视地板、霓虹呼吸灯
- 品牌主色（2026-08-02 起，"米多墨系"）：暖石墨底 + 陶土同族渐变（`#CE6B41` → `#D97757` → `#E0A06B`），对齐应用内 `--accent-primary #D97757`，与登录后工作台、桌面/移动首页统一为暖调"墨系"。**紫 / 靛 / 品红全面退出**，2026-07-07 起曾采用的靛蓝-紫罗兰同族色（`#5B8DEF` → `#7C6CF0` → `#A78BFA`）已作废——受 `inkPalette` 守卫测试拦截，不得恢复

---

## 二、强制规则（Hard Rules）

### R1 · 只允许一种"签名渐变"

所有品牌强调色必须引用 `HERO_GRADIENT`，不得自造渐变。

签名渐变是一个**统一导出的常量**（135 度，陶土三段过渡），落地页与登录页共用同一份。
**不许就地写渐变**：任何自造的渐变都会让品牌色出现第二套，两套一旦并存就再也收不回来。

用途：主 CTA 背景、顶栏登录按钮、Logo 内底色、标题渐变文字、FinalCta 大字、登录页 RetroHorizon 装饰与主 CTA 投影（2026-07-07 起登录页同步收敛到同一渐变，不再自造独立配色）。

### R2 · 背景只能用 `StaticBackdrop`

全站背景**零动画、零 canvas、零 JS**。由 `prd-admin/src/pages/home/components/StaticBackdrop.tsx` 提供的 6 层 CSS 合成（深色底 + 点阵网格 + 冷白径向光晕 + CRT 扫描线 + 噪点 + 顶栏阴影）。

两种挂载模式：

| 场景 | 用法 | 说明 |
|------|------|------|
| 独立全屏页（/home、/login 等不走 AppShell 的路由） | `<StaticBackdrop />` | 默认 `mode="fixed"`，`fixed inset-0` 覆盖整个视口 |
| AppShell 内 Outlet 页（/arena、/dashboard 等有左侧栏/顶栏的路由） | `<div className="relative"><StaticBackdrop mode="absolute" />…</div>` | `absolute inset-0` 仅填满当前容器，不会穿透 AppShell 的侧边栏/顶栏 |

- 否 禁止：粒子 canvas、鼠标视差、Three.js 着色器、mesh gradient 连续动画
- 否 禁止：任何 `fixed` 定位的亮带（地平线/太阳/地板），会穿透下方 section 产生"银光"伪影
- 否 禁止：在 AppShell 内 Outlet 页使用默认 `mode="fixed"`——会遮住左侧导航
- 是 允许：局部化（`absolute`）的 retro 装饰，且只限 Hero 段内部（参考 `HeroSection.tsx` 前 100 行）

### R3 · 三套字体各司其职

| 变量 | 族 | 用途 | 字距 |
|------|----|------|------|
| `--font-display` | Space Grotesk 400-700 | 主标题、副标题、nav、按钮 | `-0.035em` ~ `-0.005em`（负字距） |
| `--font-body` | Inter 300-700 | 正文、描述、表单 label | `0.005em` |
| `--font-mono` | VT323 | HUD chip、eyebrow、状态标签 | `0.14em` ~ `0.2em`（UPPERCASE） |

字体已在 `prd-admin/index.html` 通过 Google Fonts 预连接 + 加载。页面写样式时必须用 `style={{ fontFamily: 'var(--font-display)' }}` 等 CSS 变量形式，禁止硬编码 `'Space Grotesk'`。

### R4 · 进场动效统一走 `Reveal`

所有"进入视口后出现的元素"必须包 `<Reveal>`：
- 默认 offset 28px、duration 900ms、cubic-bezier(0.2, 0.9, 0.2, 1)
- **一次性触发**——滚回去再回来不会重播（避免"来回晃"的廉价感）
- 同一组兄弟元素用 `delay` 阶梯（推荐 80ms / 级）
- 必须尊重 `prefers-reduced-motion`（`Reveal` 内部已处理）

### R5 · HUD Chip 必须按 SectionHeader 规格

所有"小标签 / 状态条"的规格是**一套固定配方**，只有强调色一个变量：等宽字体、宽字距、全大写文案，
背景取强调色约 4% 透明度、边框约 24%、外发光与内发光都由同一个强调色派生。
**规格不许逐处调**——要改就改那份共享的标签组件，否则每个页面都会长出一个「差一点点」的版本。

带 live dot 的版本（"Live · ONLINE"）用 `animate-ping` + emerald-400 发光。参考 `HeroSection` 的状态条和 `SectionHeader.tsx`。

### R6 · CTA 必须是对称双胞胎

主 CTA + 次 CTA 永远**同高、同 radius、同字号**，一实一虚：

```
[ Sparkles | 立即开始 | →  ]   ← HERO_GRADIENT pill，0 0 48px rgba(200,98,58,0.35) 晕影，深墨字（HERO_GRADIENT_FG，非白字——渐变对白字对比度不达标）
[  Play   | 观看演示 | →  ]   ← rgba(255,255,255,0.04) + 1px 白 18% 边 + backdrop-blur 12px
```

高度 `h-12`、`rounded-full`、`px-8`、字号 `14.5px`、font-display、letter-spacing `0.01em`。

### R7 · 标题走"ambient neon pulse"

主 hero h1 允许极慢呼吸发光（5s ease-in-out，`text-shadow` 在两个状态之间插值），但：
- 只允许用在第一屏主标题
- `prefers-reduced-motion` 时必须禁用
- 其他 section 的 h2 只允许**静态** `text-shadow: 0 0 32px ${accent}2e`

### R8 · 米多墨系同族色原则（2026-08-02 起替代旧"靛蓝-紫罗兰"原则）

品牌强调色统一收敛到 `HERO_GRADIENT` 的陶土同族色系，且与应用内首页/工作台共享的**八色墨带**（`INK_HUES`，定义见文末「实现来源」）同一支笔。单独使用的强调色优先顺序：

```
slate-300 (#cbd5e1)  ← 冷白，中性基调
clay      (#CE6B41)  ← 主 accent（HERO_GRADIENT 起点，陶土）
clay-2    (#D97757)  ← 次 accent（HERO_GRADIENT 中段，对齐 --accent-primary #D97757）
clay-3    (#E0A06B)  ← HERO_GRADIENT 终点，浅陶土
emerald   (#34d399)  ← 状态 / 存活 / 成功（不变）
```

八色墨带（`INK_HUES`，用于品类色/图标色，不用于品牌主渐变）：陶土 `clay`（视觉/影像）、焦糖 `caramel`（缺陷/生产）、琥珀 `amber`（市场/AI）、橄榄 `olive`（阅读/文档）、松绿 `pine`（写作/代码）、黛青 `celadon`（流程/协作）、钢青 `steel`（音视频/网络）、钢蓝 `slate`（结构/管理）。

**禁止**：紫 / 靛 / 品红任何色相（含 hex / `rgba()` / `hsl()` / Tailwind 紫系类）在受管范围内出现，或脱离 `HERO_GRADIENT` / `INK_HUES` 另造强调色（如恢复旧青色 `#00f0ff`、旧玫红 `#f43f5e`、2026-07-07 曾用的靛蓝-紫罗兰 `#5B8DEF`/`#7C6CF0`/`#A78BFA`）。有一条 no-purple 守卫测试按色相+饱和度+明度判定，覆盖三个首页与共享色板，另有一条守卫禁止"accent 当底 + 白字"的低对比度组合（见文末「实现来源」）。

### R9 · 卡片玻璃化

卡片玻璃感的配方同样固定：深色半透明底（约 72% 不透明）、极淡白边（约 12%）、
中等强度背景模糊、一层大而软的外投影加一层极淡内发光、圆角约 22。
**这几个数是一组，不是六个独立参数**——单独调其中一个（比如只加深投影）就会脱离整套视觉语言。

内层 headline 用 `SectionHeader` 版式，不再自造 `<h2>` 样式。

### R10 · i18n 双语默认

所有用户可见文案（标题、副标题、bullet、CTA、nav）必须走 `useLanguage()`，不得硬编码中文。示意"伪数据"（mockup 里的对话标题、进度百分比等示例内容）允许保持中文，因为它们是产物而不是 UI chrome。

---

## 三、颜色系统速查表

| 用途 | 值 | 语义 |
|------|----|------|
| 基底 | `#100E0C` | 暖石墨，页面最深背景（取代早期冷黑 `#030306`/`#050510`） |
| 文字主 | `#ffffff` / `white` | 标题、一等信息 |
| 文字副 | `rgba(255,255,255,0.62)` | 副标题 / 描述 |
| 文字弱 | `rgba(255,255,255,0.55)` | 导航、tooltip |
| 边框默认 | `rgba(255,255,255,0.18)` | input、outline button |
| 边框 hover | `rgba(203,213,225,0.5)` | 冷白高亮 |
| 冷白光晕 | `rgba(203,213,225,0.28)` | 顶部背景光晕 |
| 陶土 | `#CE6B41` | HERO_GRADIENT 起点 / 主 accent |
| 陶土-2 | `#D97757` | HERO_GRADIENT 中段（对齐 `--accent-primary #D97757`） |
| 浅陶土 | `#E0A06B` | HERO_GRADIENT 终点 |
| 渐变前景字 | `var(--button-primary-fg)`（`HERO_GRADIENT_FG`） | 铺在 HERO_GRADIENT 上的文字色，深墨字非白字（对比度） |
| 存活绿 | `#34d399` | live dot |

> 2026-08-02 起 synthwave 地平线/太阳/Tron 地板等装饰同步收敛到陶土同族色，不再使用青 (`#00f0ff`) / 玫瑰 (`#f43f5e`) / 靛蓝-紫罗兰（2026-07-07 曾用，已作废）独立配色。

---

## 四、可复用零件清单

以下组件是"首页风格"的官方实现，新页面沿用这一风格时**必须直接导入**，不得抄写重造：

| 组件 | 路径 | 用途 |
|------|------|------|
| `StaticBackdrop` | `pages/home/components/StaticBackdrop.tsx` | 六层 CSS 静态背景 |
| `Reveal` | `pages/home/components/Reveal.tsx` | fade-up 进场 |
| `useInView` | `pages/home/hooks/useInView.ts` | Reveal 底层 hook |
| `SectionHeader` | `pages/home/components/SectionHeader.tsx` | eyebrow chip + h2 + 副标题 |
| `TechLogoBar` | `pages/home/components/TechLogoBar.tsx` | "Powered by" 文字模型条 |
| `HERO_GRADIENT` / `HERO_GRADIENT_TEXT` | `pages/home/sections/HeroSection.tsx` | 签名渐变常量 |
| `LanguageToggle` | `pages/home/components/LanguageToggle.tsx` | 中 / EN 切换 |
| `LanguageProvider` / `useLanguage` | `pages/home/contexts/LanguageContext.tsx` | i18n 上下文 |

> **注**：这些零件目前放在 `pages/home/` 下是历史原因。当它们被 3+ 页面复用后，应上抬到 `src/components/landing-style/`，届时同步更新本文件的路径。

---

## 五、Do / Don't 对照表

| 否 Don't | 是 Do |
|---------|------|
| 画一个 canvas 粒子背景 | 用 `StaticBackdrop` |
| 造新的 `linear-gradient(...)` 当品牌色 | 引入 `HERO_GRADIENT` |
| 在 section 里硬写 `<h2 className="text-5xl ...">` | 用 `<SectionHeader>` |
| 用 framer-motion 做入场动画 | 用 `<Reveal>` |
| 按钮宽度自适应文字 | 主次 CTA 对称，`h-12 px-8 rounded-full` |
| 脱离 `HERO_GRADIENT` / `INK_HUES` 另造强调色（恢复旧青/玫红/紫/靛/品红） | 强调色统一走陶土色阶或八色墨带 |
| 中文硬编码 | 走 `useLanguage()` 字典 |
| 在 fixed 层画"地平线亮带" | 局部化到 Hero 内部，absolute 绝不 fixed |
| 标题持续闪烁 | 只有 hero h1 允许 5s 极慢呼吸 |
| 自造 card 样式 | 参考 R9 玻璃化规格 |

---

## 六、审计清单（新页面上线前自查）

- [ ] 背景是 `StaticBackdrop`，没有 canvas / 粒子 / mesh 动画
- [ ] 所有渐变高亮色都是 `HERO_GRADIENT` 的引用，没有其他写法
- [ ] 字体全部走 `var(--font-display)` / `var(--font-body)` / `var(--font-mono)`
- [ ] 所有"小标签"是 HUD chip 规格（mono + UPPERCASE + accent 发光边）
- [ ] 所有进场元素包了 `<Reveal>`，且尊重 reduced-motion
- [ ] 主次 CTA 对称双胞胎（`h-12 px-8 rounded-full`）
- [ ] 没有脱离 `HERO_GRADIENT` / `INK_HUES` 的独立强调色（旧青 `#00f0ff` / 旧玫红 `#f43f5e` / 已作废的靛蓝-紫罗兰）；no-purple 守卫测试绿（见文末「实现来源」）
- [ ] 文案走 i18n 字典，或明确标注为"伪数据保持中文"
- [ ] 卡片符合 R9 玻璃化规格

---

## 七、关联文件

- `prd-admin/index.html` — Google Fonts 预连接
- `.claude/rules/frontend-architecture.md` — 组件复用与注册表模式
- `prd-admin/src/lib/__tests__/inkPalette.test.ts` — 米多墨系 no-purple 守卫测试（SSOT）
- `prd-admin/src/lib/tileAccent.ts` — `INK_HUES` 八色墨带定义

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 | 作用 |
|------|------|------|
| 七、关联文件 | `prd-admin/src/pages/home/LandingPage.tsx` | 十一幕骨架 |
| 七、关联文件 | `prd-admin/src/pages/home/sections/HeroSection.tsx` | 风格源头（HERO_GRADIENT / hero-title-pulse / hud-pulse） |
| 七、关联文件 | `prd-admin/src/pages/home/components/StaticBackdrop.tsx` | 背景 |
| 七、关联文件 | `prd-admin/src/pages/home/components/SectionHeader.tsx` | 幕头版式 |
| 七、关联文件 | `prd-admin/src/pages/home/components/Reveal.tsx` | 进场动效 |
| 七、关联文件 | `prd-admin/src/styles/tokens.css` | 字体 CSS 变量 |
