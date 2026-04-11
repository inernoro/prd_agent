# rule.landing-visual-style — 首页 / 登录页视觉语言规范

> **范围**：`prd-admin/src/pages/home/` + 所有对外展示类页面（登录、分享、落地、订阅邮件 H5 等）。
> **权威出处**：PR inernoro/prd_agent#405（`claude/redesign-homepage-gTSAf`），把 /home 从"粒子堆 + 代理卡片秀"重做成 Linear.app × Retro-Futurism 融合的九幕叙事。
> **维护原则**：每次更新整页替换，不保留历史变更记录（历史由 git + changelogs 承担）。

---

## 一、风格定位：Linear × Retro-Futurism

一句话：**Linear.app 的克制排版 + 80 年代 Synthwave / Tron 的冷光装饰**。

- Linear.app 的骨架：极窄字距、静态背景、滚动 fade-up、单一长景、大量留白
- Retro-Futurism 的点缀：HUD 终端 chip、CRT 扫描线、Synthwave 地平线、Tron 透视地板、霓虹呼吸灯
- 去紫化：主色从"AI 紫"迁移到冷白 (slate-300) + 青 (#00f0ff) + 玫瑰 (#f43f5e)，紫 (#7c3aed) 只作为三色渐变的中段

---

## 二、强制规则（Hard Rules）

### R1 · 只允许一种"签名渐变"

所有品牌强调色必须引用 `HERO_GRADIENT`，不得自造渐变。

```ts
// 出处：prd-admin/src/pages/home/sections/HeroSection.tsx
export const HERO_GRADIENT = 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)';
```

用途：主 CTA 背景、顶栏登录按钮、Logo 内底色、标题渐变文字、FinalCta 大字。

### R2 · 背景只能用 `StaticBackdrop`

全站背景**零动画、零 canvas、零 JS**。由 `prd-admin/src/pages/home/components/StaticBackdrop.tsx` 提供的 6 层 CSS 合成（深色底 + 点阵网格 + 冷白径向光晕 + CRT 扫描线 + 噪点 + 顶栏阴影）。

- ❌ 禁止：粒子 canvas、鼠标视差、Three.js 着色器、mesh gradient 连续动画
- ❌ 禁止：任何 `fixed` 定位的亮带（地平线/太阳/地板），会穿透下方 section 产生"银光"伪影
- ✅ 允许：局部化（`absolute`）的 retro 装饰，且只限 Hero 段内部（参考 `HeroSection.tsx` 前 100 行）

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

所有"小标签 / eyebrow / 状态条"必须是：

```tsx
<div
  className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md"
  style={{
    fontFamily: 'var(--font-mono)',
    background: `${accent}0a`,                  // 10/255 alpha
    border: `1px solid ${accent}3d`,            // 61/255 alpha
    boxShadow: `0 0 20px ${accent}33, inset 0 0 10px ${accent}0a`,
  }}
>
  <Icon style={{ color: accent }} />
  <span style={{ color: accent, letterSpacing: '0.2em', textShadow: `0 0 10px ${accent}99` }}>
    TEXT UPPERCASE
  </span>
</div>
```

带 live dot 的版本（"Live · ONLINE"）用 `animate-ping` + emerald-400 发光。参考 `HeroSection` 的状态条和 `SectionHeader.tsx`。

### R6 · CTA 必须是对称双胞胎

主 CTA + 次 CTA 永远**同高、同 radius、同字号**，一实一虚：

```
[ Sparkles | 立即开始 | →  ]   ← HERO_GRADIENT pill，0 0 48px rgba(124,58,237,0.35) 晕影
[  Play   | 观看演示 | →  ]   ← rgba(255,255,255,0.04) + 1px 白 18% 边 + backdrop-blur 12px
```

高度 `h-12`、`rounded-full`、`px-8`、字号 `14.5px`、font-display、letter-spacing `0.01em`。

### R7 · 标题走"ambient neon pulse"

主 hero h1 允许极慢呼吸发光（5s ease-in-out，`text-shadow` 在两个状态之间插值），但：
- 只允许用在第一屏主标题
- `prefers-reduced-motion` 时必须禁用
- 其他 section 的 h2 只允许**静态** `text-shadow: 0 0 32px ${accent}2e`

### R8 · "去紫"原则

紫色 `#7c3aed` 只允许出现在 `HERO_GRADIENT` 的中段。单独使用的强调色优先顺序：

```
slate-300 (#cbd5e1)  ← 冷白，主基调
cyan      (#00f0ff)  ← 主 accent
teal      (#0e7490)  ← 次 accent
rose      (#f43f5e)  ← 强调 / 告警 / 热度
emerald   (#34d399)  ← 状态 / 存活 / 成功
```

禁止：任何单独的全紫按钮、全紫卡片、全紫 hover。紫色只能作为渐变的一段或极小面积的发光。

### R9 · 卡片玻璃化

任何 card/panel 的"玻璃效果"必须遵循：

```css
background: rgba(10, 14, 22, 0.72);    /* 深色半透明 */
border: 1px solid rgba(255, 255, 255, 0.12);
backdrop-filter: blur(14px);
box-shadow: 0 18px 54px rgba(0, 0, 0, 0.55), inset 0 0 10px rgba(148, 163, 184, 0.04);
border-radius: 22px;                   /* clamp 18-24 */
```

内层 headline 用 `SectionHeader` 版式，不再自造 `<h2>` 样式。

### R10 · i18n 双语默认

所有用户可见文案（标题、副标题、bullet、CTA、nav）必须走 `useLanguage()`，不得硬编码中文。示意"伪数据"（mockup 里的对话标题、进度百分比等示例内容）允许保持中文，因为它们是产物而不是 UI chrome。

---

## 三、颜色系统速查表

| 用途 | 值 | 语义 |
|------|----|------|
| 基底 | `#030306` / `#050510` | 页面最深背景 |
| 文字主 | `#ffffff` / `white` | 标题、一等信息 |
| 文字副 | `rgba(255,255,255,0.62)` | 副标题 / 描述 |
| 文字弱 | `rgba(255,255,255,0.55)` | 导航、tooltip |
| 边框默认 | `rgba(255,255,255,0.18)` | input、outline button |
| 边框 hover | `rgba(203,213,225,0.5)` | 冷白高亮 |
| 冷白光晕 | `rgba(203,213,225,0.28)` | 顶部背景光晕 |
| 青光 | `rgba(0,240,255,0.5)` | HUD / accent |
| 玫瑰 | `rgba(244,63,94,0.5)` | synthwave 地平线 |
| 存活绿 | `#34d399` | live dot |

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

| ❌ Don't | ✅ Do |
|---------|------|
| 画一个 canvas 粒子背景 | 用 `StaticBackdrop` |
| 造新的 `linear-gradient(...)` 当品牌色 | 引入 `HERO_GRADIENT` |
| 在 section 里硬写 `<h2 className="text-5xl ...">` | 用 `<SectionHeader>` |
| 用 framer-motion 做入场动画 | 用 `<Reveal>` |
| 按钮宽度自适应文字 | 主次 CTA 对称，`h-12 px-8 rounded-full` |
| 用紫色做单独的高亮块 | 用冷白 / 青，紫色只做渐变中段 |
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
- [ ] 没有裸紫色高亮块，紫色只在 HERO_GRADIENT 中段
- [ ] 文案走 i18n 字典，或明确标注为"伪数据保持中文"
- [ ] 卡片符合 R9 玻璃化规格

---

## 七、关联文件

- `prd-admin/src/pages/home/LandingPage.tsx` — 十一幕骨架
- `prd-admin/src/pages/home/sections/HeroSection.tsx` — 风格源头（HERO_GRADIENT / hero-title-pulse / hud-pulse）
- `prd-admin/src/pages/home/components/StaticBackdrop.tsx` — 背景
- `prd-admin/src/pages/home/components/SectionHeader.tsx` — 幕头版式
- `prd-admin/src/pages/home/components/Reveal.tsx` — 进场动效
- `prd-admin/src/styles/tokens.css` — 字体 CSS 变量
- `prd-admin/index.html` — Google Fonts 预连接
- `.claude/rules/frontend-architecture.md` — 组件复用与注册表模式
