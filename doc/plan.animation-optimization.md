# 动画优化计划 — 基于 ReactBits 组件库

> **版本**: v1.0
> **日期**: 2026-02-24
> **状态**: DRAFT
> **参考**: [ReactBits](https://reactbits.dev) — 110+ 开源动画组件库

---

## 1. 背景与目标

### 1.1 现状分析

当前项目自研了大量动画代码，分布如下：

| 指标 | 数量 |
|------|------|
| CSS @keyframes 动画 | 40+ 个 |
| Canvas 2D 动画 | 2 个 (ParticleField, StarfieldBackground) |
| WebGL 着色器 | 2 个 (BlackHoleVortex, Starfield) |
| 特效组件 | 14+ 个 |
| 动画相关代码行数 | ~8,000 行 (CSS + TSX) |
| requestAnimationFrame 调用 | 39+ 处 |
| 涉及动画的页面 | 15+ 个 |

**主要问题：**

1. **维护成本高** — 40+ 自定义 @keyframes 分散在 globals.css（1,320 行），修改一个动画需要理解大量上下文
2. **性能隐患** — backdrop-filter + box-shadow 动画在低端设备上掉帧；ParticleField 做 O(n²) 距离检测
3. **一致性不足** — 各页面动画风格、时长、缓动函数不统一
4. **复用率低** — 多处重复实现 fadeIn/slideUp/shimmer 等通用模式

### 1.2 优化目标

| 目标 | 描述 |
|------|------|
| **减少自研代码** | 用 ReactBits 组件替换可替代的自研动画，减少 30-50% 动画代码量 |
| **提升性能** | 消除已知性能瓶颈（backdrop-filter 动画、O(n²) 粒子碰撞等） |
| **统一体验** | 建立动画规范，统一缓动曲线、时长、交互反馈 |
| **降低门槛** | 新功能优先使用 ReactBits 组件，降低开发和设计成本 |

---

## 2. ReactBits 组件映射

### 2.1 可直接替换的自研组件

以下自研组件可被 ReactBits 对应组件替换，减少维护负担：

| 自研组件 | 位置 | 代码行数 | ReactBits 替代 | 优先级 |
|----------|------|----------|---------------|--------|
| `TypewriterText` | `prd-admin/src/pages/home/components/` | 68 行 | **DecryptedText** / **GlitchText** | P1 |
| `CountUpNumber` | `prd-admin/src/pages/home/components/` | 84 行 | **CountUp** | P1 |
| `ParticleField` | `prd-admin/src/pages/home/components/` | 175 行 | **Particles** (Background) | P1 |
| `GlowOrb` | `prd-admin/src/pages/home/components/` | 60 行 | **Aurora** (Background) | P2 |
| `fadeInUp` 动画 | `globals.css` 多处 | 分散 | **SplitText** / **BlurText** | P2 |
| 文字渐变效果 | 多个页面 | 分散 | **GradientText** / **ShinyText** | P2 |
| `SparkleButton` | `prd-admin/src/components/effects/` | 80+ 行 | 保留（特色组件） | — |
| `NeonButton` | `prd-admin/src/components/effects/` | 80+ 行 | 保留（特色组件） | — |

### 2.2 新增可引入的 ReactBits 组件

以下 ReactBits 组件可增强现有页面体验：

| ReactBits 组件 | 应用场景 | 目标页面 |
|---------------|---------|---------|
| **BlurText** | 页面标题入场动画 | LandingPage, LoginPage |
| **SplitText** | 章节标题拆字动画 | LandingPage 各 Section |
| **ScrollReveal** | 滚动触发内容显现 | LandingPage 长页面 |
| **ScrollFloat** | 滚动浮入效果 | LandingPage 功能卡片 |
| **Magnet** | 按钮磁吸交互 | CTA 按钮、导航元素 |
| **SplashCursor** | 鼠标跟随效果 | LandingPage（可选） |
| **SpotlightCard** | 聚光灯卡片悬停 | 功能展示区、Agent 切换器 |
| **TiltedCard** | 3D 倾斜卡片 | 模型管理、Agent 卡片 |
| **AnimatedList** | 列表入场动画 | 会话列表、消息列表 |
| **Dock** | macOS 风格导航栏 | 底部工具栏（可选） |
| **CircularGallery** | 环形画廊展示 | 视觉创作作品展示 |
| **Iridescence** | 彩虹光泽背景 | 特色页面背景 |
| **GridMotion** | 网格运动背景 | 管理后台空状态 |
| **CircularText** | 环形文字装饰 | Loading 状态、徽章 |

### 2.3 不替换的组件（保留自研）

| 组件 | 保留原因 |
|------|---------|
| `StarfieldBackground` (WebGL) | 深度定制的宇宙着色器，ReactBits 无等价物 |
| `BlackHoleVortex` (WebGL) | Droste 递归效果，高度定制 |
| `GlassCard` 液态玻璃 | 核心设计语言，与主题系统深度绑定 |
| `PrdPetalBreathingLoader` | 品牌特色 Loading，已优化 |
| `ThemeFlipTransition` (Desktop) | Tauri 主题切换编排，与状态管理绑定 |
| `ClickMeButton` (Desktop) | 自定义 CSS mask 动画，独特交互 |
| 工作流画布动画 | 与 React Flow 深度集成 |

---

## 3. 性能优化方案

### 3.1 已知性能瓶颈修复

#### P0 — 关键性能问题

| 问题 | 当前状态 | 优化方案 | 预期收益 |
|------|---------|---------|---------|
| **ParticleField O(n²) 碰撞检测** | 80 粒子 = 6,400 次/帧距离计算 | 替换为 ReactBits **Particles** 组件（WebGL 加速） | GPU 渲染，帧率提升 50%+ |
| **backdrop-filter 在 Windows 上卡顿** | 性能模式已存在但未完全覆盖 | 扩展性能模式：所有 backdrop-filter 元素加 `translateZ(0)` 隔离层 | Windows 用户体验显著改善 |
| **Landing Page GPU 争用** | WebGL + Canvas + Glass 同时渲染 | 懒加载 Landing 特效组件 + IntersectionObserver 控制启停 | 首屏加载时间减少 40% |

#### P1 — 中等性能问题

| 问题 | 优化方案 |
|------|---------|
| 多层 box-shadow 动画 (15+ 处) | 用 `::after` 伪元素 + opacity 过渡替代直接 box-shadow 动画 |
| 14s+ 持续运行动画 (modelMapStarDrift 等) | 加 IntersectionObserver，不可见时暂停 |
| AdvancedVisualAgentTab 20+ RAF 调用 | 提取为独立 memoized 子组件，隔离渲染边界 |
| scroll 事件未节流 (ModelManagePage) | 添加 passive listener + requestAnimationFrame 节流 |

#### P2 — 低优先级优化

| 问题 | 优化方案 |
|------|---------|
| 效果组件未 React.memo | GlowingCard, OrbitLoader 等加 memo 边界 |
| will-change 未清理 (2 处) | 动画结束后重置 `will-change: auto` |
| RAF 未取消 (event handler 中) | 添加 cleanup 返回值 |

### 3.2 动画性能规范

建立统一的动画性能守则：

```
┌─────────────────────────────────────────────────────┐
│                 动画性能金字塔                        │
├─────────────────────────────────────────────────────┤
│  ✅ 仅使用 transform + opacity (Compositor 层)       │
│  ⚠️ filter / backdrop-filter (需 GPU 隔离层)         │
│  ❌ width/height/top/left/color (触发 Layout/Paint)  │
│  ❌ box-shadow 动画 (用伪元素 opacity 替代)           │
└─────────────────────────────────────────────────────┘
```

**规则：**

1. **Compositor 优先** — 动画仅操作 `transform` 和 `opacity`
2. **GPU 隔离** — 使用 `backdrop-filter` 的元素必须加 `will-change: transform; transform: translateZ(0)`
3. **可见性控制** — 持续动画必须通过 IntersectionObserver 在不可见时暂停
4. **Reduced Motion** — 所有动画必须尊重 `prefers-reduced-motion: reduce`
5. **帧率目标** — 复杂动画（WebGL/Canvas）目标 30fps，UI 交互动画目标 60fps

---

## 4. 实施计划

### Phase 1: 基础集成 + 快速替换（Week 1-2）

**目标：** 引入 ReactBits，替换最直接的组件

| 任务 | 详情 | 工作量 |
|------|------|--------|
| 安装 ReactBits | 配置 jsrepo CLI，选择 TS-TW 变体 | 0.5d |
| 替换 `CountUpNumber` | → ReactBits **CountUp** | 0.5d |
| 替换 `TypewriterText` | → ReactBits **DecryptedText** | 0.5d |
| 替换 `ParticleField` | → ReactBits **Particles** | 1d |
| 替换 `GlowOrb` | → ReactBits **Aurora** | 0.5d |
| 清理被替换的自研代码 | 删除旧组件 + 未使用的 @keyframes | 0.5d |
| 性能回归测试 | Lighthouse + Chrome DevTools Performance | 0.5d |

**交付物：** 减少 ~400 行自研动画代码，Landing Page 使用 ReactBits 组件

### Phase 2: Landing Page 增强（Week 3-4）

**目标：** 用 ReactBits 升级 Landing Page 的视觉效果

| 任务 | 详情 | 工作量 |
|------|------|--------|
| 引入 **BlurText** | 替换现有标题 fadeInUp 动画 | 0.5d |
| 引入 **SplitText** | 章节标题拆字入场效果 | 0.5d |
| 引入 **ScrollReveal** | 替换自研 fadeIn 滚动动画 | 1d |
| 引入 **ScrollFloat** | 功能卡片滚动浮入 | 0.5d |
| 引入 **SpotlightCard** | 功能展示区卡片悬停效果 | 1d |
| 统一 globals.css | 清理已被 ReactBits 替代的 @keyframes | 0.5d |
| 性能优化 | Landing 特效 lazy-load + IntersectionObserver | 1d |

**交付物：** Landing Page 视觉升级 + globals.css 瘦身 30%

### Phase 3: 性能优化专项（Week 5-6）

**目标：** 解决所有已知性能瓶颈

| 任务 | 详情 | 工作量 |
|------|------|--------|
| backdrop-filter 隔离层全覆盖 | 所有 blur 元素加 GPU 隔离 | 1d |
| box-shadow 动画重构 | 15+ 处改为伪元素 opacity 方案 | 1.5d |
| 长时间动画可见性控制 | IntersectionObserver 暂停不可见动画 | 1d |
| AdvancedVisualAgentTab 拆分 | 7000 行组件提取 memoized 子组件 | 2d |
| scroll 事件节流 | 全局 scroll listener 加 RAF 节流 | 0.5d |
| 性能模式增强 | 扩展 `data-perf-mode` 覆盖新增动画 | 0.5d |

**交付物：** Windows 设备动画流畅度提升；低端设备无掉帧

### Phase 4: 管理后台 + Desktop 增强（Week 7-8）

**目标：** 将 ReactBits 动画扩展到其他模块

| 任务 | 详情 | 工作量 |
|------|------|--------|
| 引入 **AnimatedList** | 会话列表 / 消息列表入场动画 | 1d |
| 引入 **TiltedCard** | Agent 切换器 / 模型管理卡片 | 1d |
| 引入 **Magnet** | CTA 按钮磁吸交互效果 | 0.5d |
| 引入 **GradientText** | 替换自研渐变文字效果 | 0.5d |
| Desktop 动画同步 | 评估 ReactBits 在 Tauri WebView 的兼容性 | 1d |
| 文档更新 | 更新 CLAUDE.md + SRS 动画部分 | 0.5d |

**交付物：** 全平台动画体验统一；开发文档更新

---

## 5. 技术方案

### 5.1 ReactBits 集成方式

ReactBits 使用 `jsrepo` CLI 安装，组件代码直接复制到项目中（非 npm 依赖），选择 **TS-TW** 变体以匹配项目技术栈：

```bash
# 安装 jsrepo CLI
npx jsrepo add github/DavidHDev/react-bits

# 安装特定组件（示例）
npx jsrepo add github/DavidHDev/react-bits/TextAnimations/BlurText-TS-TW
npx jsrepo add github/DavidHDev/react-bits/Backgrounds/Particles-TS-TW
```

**组件存放位置：**

```
prd-admin/src/components/reactbits/    # ReactBits 组件统一目录
├── text/                               # 文字动画
│   ├── BlurText.tsx
│   ├── SplitText.tsx
│   ├── CountUp.tsx
│   └── DecryptedText.tsx
├── backgrounds/                        # 背景动画
│   ├── Particles.tsx
│   └── Aurora.tsx
├── animations/                         # 交互动画
│   └── Magnet.tsx
└── components/                         # UI 组件
    ├── SpotlightCard.tsx
    ├── TiltedCard.tsx
    └── AnimatedList.tsx
```

### 5.2 与现有主题系统集成

ReactBits 组件需适配项目的液态玻璃主题系统：

```typescript
// 示例：BlurText 适配主题
import { BlurText } from '@/components/reactbits/text/BlurText';
import { useThemeStore } from '@/stores/themeStore';

function ThemedBlurText({ text, ...props }) {
  const { perfMode } = useThemeStore();

  // 性能模式下简化动画
  if (perfMode === 'performance') {
    return <span className="transition-opacity duration-200">{text}</span>;
  }

  return <BlurText text={text} {...props} />;
}
```

### 5.3 性能模式兼容

所有 ReactBits 组件必须尊重现有的性能模式系统：

```css
/* globals.css 追加 */
html[data-perf-mode="performance"] .reactbits-animation {
  animation: none !important;
  transition: none !important;
}
```

### 5.4 GSAP 依赖管理

ReactBits 的 ScrollReveal、ScrollFloat、GridMotion 依赖 GSAP：

```bash
# GSAP 安装（免费版支持 ScrollTrigger）
pnpm add gsap
```

**注意：** GSAP 免费版 License 允许商业使用，但 ScrollSmoother 等高级插件需付费。计划中仅使用免费的 ScrollTrigger 功能。

---

## 6. 质量保障

### 6.1 性能基线

在 Phase 1 开始前建立性能基线：

| 指标 | 测量工具 | 目标值 |
|------|---------|--------|
| LCP (Largest Contentful Paint) | Lighthouse | < 2.5s |
| CLS (Cumulative Layout Shift) | Lighthouse | < 0.1 |
| TBT (Total Blocking Time) | Lighthouse | < 200ms |
| 动画帧率 (交互动画) | Chrome DevTools | ≥ 55fps |
| 动画帧率 (WebGL 背景) | Chrome DevTools | ≥ 28fps |
| JS Bundle 增量 | Vite build | < 50KB gzip |

### 6.2 回归检查清单

每个 Phase 完成后执行：

- [ ] Lighthouse Performance Score ≥ 基线
- [ ] Windows 10/11 Chrome 无掉帧
- [ ] macOS Safari 动画正常
- [ ] `prefers-reduced-motion: reduce` 生效
- [ ] 性能模式下动画正确降级
- [ ] Tauri WebView 兼容（Phase 4）
- [ ] 无新增 console warning/error

### 6.3 浏览器兼容

| 浏览器 | 最低版本 | 备注 |
|--------|---------|------|
| Chrome | 90+ | 主要目标 |
| Edge | 90+ | Chromium 内核 |
| Safari | 15+ | WebKit prefix 兼容 |
| Firefox | 95+ | 次要目标 |
| Tauri WebView | WebKit 最新 | Desktop 端 |

---

## 7. 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| ReactBits 组件与液态玻璃主题冲突 | 中 | 中 | Phase 1 先在 Landing Page 验证，再推广 |
| GSAP 包体积过大 | 低 | 低 | Tree-shaking + 动态 import，仅加载 ScrollTrigger |
| ReactBits 停止维护 | 低 | 低 | 代码已复制到项目，不依赖远程包 |
| 替换后视觉风格不一致 | 中 | 中 | 每个替换组件由设计确认后再合入 |
| Tauri WebView 不支持某些 CSS 特性 | 中 | 低 | Phase 4 专项兼容测试 |

---

## 8. 预期收益

| 维度 | 当前 | 优化后 | 提升 |
|------|------|--------|------|
| 自研动画代码行数 | ~8,000 行 | ~5,000 行 | **-37%** |
| globals.css @keyframes | 40+ 个 | ~25 个 | **-37%** |
| Landing Page 首屏加载 | ~3.5s | ~2.2s | **-37%** |
| Windows 动画帧率 | ~35fps | ~55fps | **+57%** |
| 新功能动画开发时间 | 2-3 天 | 0.5-1 天 | **-60%** |
| 动画一致性 | 手工管理 | ReactBits 统一 | 规范化 |

---

## 附录 A: ReactBits 组件速查

### 文字动画
| 组件 | 效果 | 依赖 |
|------|------|------|
| BlurText | 模糊→清晰入场 | Framer Motion |
| SplitText | 逐字/逐行拆分入场 | — |
| CountUp | 数字递增动画 | — |
| DecryptedText | 解密效果文字显示 | — |
| GlitchText | 故障艺术文字 | — |
| GradientText | 渐变流动文字 | — |
| ShinyText | 闪光扫过文字 | — |
| ScrollReveal | 滚动触发显现 | GSAP |
| ScrollFloat | 滚动浮入 | GSAP |
| CircularText | 环形排列文字 | — |

### 背景
| 组件 | 效果 | 依赖 |
|------|------|------|
| Particles | 粒子系统 | — |
| Aurora | 极光效果 | — |
| Iridescence | 彩虹光泽 | — |
| GridMotion | 网格运动 | GSAP |

### UI 组件
| 组件 | 效果 | 依赖 |
|------|------|------|
| SpotlightCard | 聚光灯悬停卡片 | — |
| TiltedCard | 3D 倾斜卡片 | — |
| AnimatedList | 动画列表 | Framer Motion |
| Dock | macOS 风格 Dock | Framer Motion |
| CircularGallery | 环形画廊 | — |

### 交互动画
| 组件 | 效果 | 依赖 |
|------|------|------|
| Magnet | 磁吸交互 | — |
| BlobCursor | 液态鼠标跟随 | — |
| SplashCursor | 泼墨鼠标效果 | — |
