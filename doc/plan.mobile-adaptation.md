# 移动端适配功能规划

> **文档版本**：v1.0
> **创建日期**：2026-02-11
> **目标范围**：prd-admin (React 18 管理后台)
> **当前状态**：移动端可渲染但未优化 (适配评分 4/10)

---

## 一、现状分析

### 1.1 已有的适配基础

| 基础设施 | 状态 | 说明 |
|----------|------|------|
| Viewport meta | ✅ 已配置 | `width=device-width, initial-scale=1.0` |
| Tailwind CSS v4 | ✅ 已使用 | 默认断点 sm/md/lg/xl/2xl |
| 响应式栅格 | ⚠️ 部分 | 部分页面有 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` |
| 侧边栏折叠 | ⚠️ 手动 | 220px → 50px，需用户手动点击，无自动响应 |
| 性能模式 | ✅ 已实现 | `data-perf-mode="performance"` 去除 blur，适合低端设备 |
| 弹窗宽度 | ✅ 响应式 | `w-[92vw]` 配合 maxWidth |
| 触控支持 | ❌ 未实现 | 无 touch 事件、无手势、依赖 hover 交互 |
| 移动端导航 | ❌ 未实现 | 无底部导航栏、无抽屉菜单 |
| useMediaQuery | ❌ 未实现 | 无响应式 Hook，仅 CSS 层响应 |

### 1.2 核心问题

1. **侧边栏在移动端始终占据空间** — 即使折叠后仍有 50px 宽度
2. **无移动端导航范式** — 缺少 Hamburger 菜单 / 底部 Tab 栏
3. **弹窗交互不适配** — 居中弹窗在移动端应为底部弹出（Bottom Sheet）
4. **hover 依赖** — 多处功能依赖 `onMouseEnter/Leave`，触控设备无法触发
5. **复杂页面无简化视图** — 权限矩阵、模型管理等宽表格在小屏幕溢出
6. **无全局响应式状态** — 组件无法根据当前断点做逻辑分支

---

## 二、可抽离的公共组件

### 2.1 新建公共组件（需要创建）

| 组件名 | 路径 | 职责 | 复用场景 |
|--------|------|------|----------|
| **`useBreakpoint`** | `hooks/useBreakpoint.ts` | 响应式断点 Hook，返回当前断点 (`xs/sm/md/lg/xl`) 和 `isMobile` 布尔值 | 全局所有需要逻辑分支的组件 |
| **`MobileDrawer`** | `components/ui/MobileDrawer.tsx` | 左侧抽屉导航（Radix Dialog 实现），含手势滑动关闭 | AppShell 移动端导航 |
| **`BottomSheet`** | `components/ui/BottomSheet.tsx` | 底部弹出面板（替代 Dialog 在移动端的呈现） | 表单弹窗、确认框、筛选器 |
| **`ResponsiveGrid`** | `components/design/ResponsiveGrid.tsx` | 封装响应式栅格 + 骨架屏加载态 | 20+ 页面的卡片列表 |
| **`SearchFilterBar`** | `components/design/SearchFilterBar.tsx` | 搜索 + 筛选条件栏（桌面横排 / 移动端折叠） | UsersPage, LlmLogsPage, ModelManagePage 等 |
| **`MobileTabBar`** | `components/ui/MobileTabBar.tsx` | 底部 Tab 导航栏（5 个常用入口） | AppShell 移动端替代侧边栏 |
| **`ResponsiveDialog`** | `components/ui/ResponsiveDialog.tsx` | 桌面=居中弹窗，移动端=BottomSheet 自动切换 | 所有使用 Dialog 的地方 |
| **`SwipeableContainer`** | `components/ui/SwipeableContainer.tsx` | 手势容器，支持左右滑动切换 Tab / 删除操作 | 列表项、Tab 切换 |
| **`CollapsibleFilterPanel`** | `components/design/CollapsibleFilterPanel.tsx` | 可折叠的筛选面板（移动端默认收起） | 日志查询、数据管理 |

### 2.2 已有组件改造（需要适配）

| 组件 | 当前路径 | 改造内容 | 影响范围 |
|------|----------|----------|----------|
| **`AppShell`** | `layouts/AppShell.tsx` | 移动端隐藏侧边栏 → MobileDrawer + MobileTabBar | 全局布局 |
| **`Dialog`** | `components/ui/Dialog.tsx` | 移动端自动切换为 BottomSheet 模式 | 所有弹窗 |
| **`PageHeader`** | `components/design/PageHeader.tsx` | 移动端 Tab 横向滚动、标题缩短 | 所有带 Tab 的页面 |
| **`GlassCard`** | `components/design/GlassCard.tsx` | 移动端减少 padding、调整圆角 | 全站卡片 |
| **`Select`** | `components/design/Select.tsx` | 移动端使用原生 select 或 BottomSheet 选择器 | 所有下拉选择 |
| **`TabBar`** | `components/design/TabBar.tsx` | 移动端支持横向滚动、滑动指示器 | 多 Tab 页面 |
| **`layoutStore`** | `stores/layoutStore.ts` | 新增 `isMobile` 状态，自动检测 | 全局 |

### 2.3 组件复用决策矩阵

```
                        移动端专用        桌面端共享        是否新建
                        ─────────        ──────────        ────────
useBreakpoint           ●                ●                 ✅ 新建
MobileDrawer            ●                                  ✅ 新建
BottomSheet             ●                                  ✅ 新建
MobileTabBar            ●                                  ✅ 新建
ResponsiveGrid                           ● (取代内联)       ✅ 新建
SearchFilterBar                          ● (取代内联)       ✅ 新建
ResponsiveDialog        ●                ● (包装 Dialog)    ✅ 新建
CollapsibleFilterPanel  ●                ● (默认展开)       ✅ 新建
SwipeableContainer      ●                                  ✅ 新建

Dialog                  ● (改为底部弹出)  ● (保持居中)       改造
AppShell                ● (抽屉导航)     ● (侧边栏)         改造
PageHeader              ● (横向滚动)     ● (保持现状)       改造
GlassCard               ● (减 padding)  ● (保持现状)       改造
```

---

## 三、适配方案设计

### 3.1 断点策略

```
xs:  0    - 479px   → 手机竖屏（单列，底部导航）
sm:  480  - 639px   → 手机横屏 / 大屏手机
md:  640  - 767px   → 小平板（Tailwind 默认 md 调整为 640）
lg:  768  - 1023px  → 平板竖屏
xl:  1024 - 1279px  → 平板横屏 / 小笔记本
2xl: 1280+          → 桌面端
```

**核心分界**：`< 768px` 视为移动端，启用移动导航范式。

### 3.2 导航适配方案

```
桌面端 (≥ 768px)                    移动端 (< 768px)
┌──────────────────────┐            ┌──────────────────────┐
│ ┌────┐ ┌───────────┐ │            │ ┌──────────────────┐ │
│ │    │ │           │ │            │ │  ≡ Page Title  🔔 │ │
│ │ S  │ │           │ │            │ ├──────────────────┤ │
│ │ i  │ │  Content  │ │            │ │                  │ │
│ │ d  │ │           │ │            │ │    Content       │ │
│ │ e  │ │           │ │            │ │                  │ │
│ │ b  │ │           │ │            │ │                  │ │
│ │ a  │ │           │ │            │ ├──────────────────┤ │
│ │ r  │ │           │ │            │ │ 🏠 📊 💬 ⚙️ ··· │ │
│ └────┘ └───────────┘ │            │ └──────────────────┘ │
└──────────────────────┘            └──────────────────────┘
  侧边栏 + 内容区                     顶部栏 + 内容 + 底部Tab
```

### 3.3 弹窗适配方案

```
桌面端                                移动端
┌────────────────────┐               ┌────────────────────┐
│                    │               │                    │
│   ┌────────────┐   │               │                    │
│   │   Dialog   │   │               │                    │
│   │  (居中)     │   │               │ ┌────────────────┐ │
│   │            │   │               │ │  Bottom Sheet  │ │
│   └────────────┘   │               │ │  (底部弹出)     │ │
│                    │               │ │  可拖拽关闭     │ │
└────────────────────┘               │ └────────────────┘ │
                                     └────────────────────┘
```

### 3.4 页面级适配策略

| 页面 | 桌面布局 | 移动端适配策略 | 优先级 |
|------|----------|---------------|--------|
| **AgentLauncherPage** | 卡片网格 | 单列卡片，保持功能完整 | P0 |
| **AiChatPage** | 对话 + 侧边面板 | 全屏对话，设置入口浮动按钮 | P0 |
| **LoginPage** | 居中表单 | 全屏表单，已基本适配 | P0 |
| **LandingPage** | 多section | 已有响应式，微调间距 | P1 |
| **UsersPage** | 用户卡片网格 | 单列卡片，搜索栏折叠 | P1 |
| **LlmLogsPage** | 表格 + 筛选 | 卡片列表 + 折叠筛选 | P1 |
| **ModelManageTabsPage** | Tab + 表格 | 横向滚动 Tab + 卡片视图 | P2 |
| **PromptStagesPage** | 提示词列表 | 单列卡片 | P2 |
| **AuthzPage** | 权限矩阵表格 | 单角色详情视图（非矩阵） | P2 |
| **ExecutiveDashboardPage** | KPI 多列网格 | 单列 KPI 卡片堆叠 | P2 |
| **VisualAgentFullscreenPage** | 画布全屏 | 暂不适配（仅限桌面端提示） | P3 |
| **LiteraryAgentEditorPage** | 编辑器 | 简化工具栏，全屏编辑 | P3 |
| **ModelPoolManagePage** | 策略可视化 | 暂不适配（仅限桌面端提示） | P3 |

---

## 四、具体执行步骤

### Phase 0：基础设施搭建 (Foundation)

```
Step 0.1  创建 useBreakpoint Hook
          路径: src/hooks/useBreakpoint.ts
          功能: window.matchMedia 监听，返回 { breakpoint, isMobile, isTablet, isDesktop }
          依赖: 无

Step 0.2  扩展 layoutStore
          路径: src/stores/layoutStore.ts
          新增: isMobile (由 useBreakpoint 在 AppShell 中同步写入)
          新增: mobileDrawerOpen, setMobileDrawerOpen

Step 0.3  创建移动端 CSS Token 层
          路径: src/styles/tokens.css (追加)
          内容: --mobile-padding, --mobile-radius, --mobile-header-height, --mobile-tab-height

Step 0.4  创建移动端玻璃样式预设
          路径: src/lib/glassStyles.ts (追加)
          新增: glassBottomSheet, glassMobileHeader, glassMobileTabBar
```

### Phase 1：核心布局改造 (Layout)

```
Step 1.1  创建 MobileDrawer 组件
          路径: src/components/ui/MobileDrawer.tsx
          基于: Radix Dialog (modal mode)
          功能: 左侧滑出导航菜单，半透明遮罩，手势滑动关闭
          样式: glassSidebar 预设

Step 1.2  创建 MobileTabBar 组件
          路径: src/components/ui/MobileTabBar.tsx
          功能: 底部固定 Tab 栏 (5个入口 + 更多)
          高度: 56px + safe-area-inset-bottom
          动画: 路由切换时 active 指示器滑动

Step 1.3  改造 AppShell
          路径: src/layouts/AppShell.tsx
          改造点:
          - lg 以下隐藏侧边栏
          - 显示顶部移动端 Header（Hamburger + 标题 + 通知图标）
          - 底部显示 MobileTabBar
          - 内容区域 padding 适配 (去除左侧侧边栏间距)
          - safe-area 支持 (env(safe-area-inset-*))

Step 1.4  创建 BottomSheet 组件
          路径: src/components/ui/BottomSheet.tsx
          功能: 底部弹出面板，支持拖拽指示条 + 手势下滑关闭
          高度: 自动 / 半屏 / 全屏三档
          样式: glassBottomSheet

Step 1.5  创建 ResponsiveDialog 封装
          路径: src/components/ui/ResponsiveDialog.tsx
          逻辑: useBreakpoint().isMobile ? BottomSheet : Dialog
          API: 与现有 Dialog 完全兼容
```

### Phase 2：公共组件库 (Shared Components)

```
Step 2.1  创建 ResponsiveGrid 组件
          路径: src/components/design/ResponsiveGrid.tsx
          Props: cols (响应式配置), gap, loading, skeletonCount, skeletonHeight
          功能: 统一卡片网格 + 骨架屏

Step 2.2  创建 SearchFilterBar 组件
          路径: src/components/design/SearchFilterBar.tsx
          桌面: 横向排列 搜索框 + 筛选项 + 按钮
          移动: 搜索框全宽 + "筛选" 按钮展开 CollapsibleFilterPanel

Step 2.3  创建 CollapsibleFilterPanel 组件
          路径: src/components/design/CollapsibleFilterPanel.tsx
          功能: 可折叠/展开的筛选条件区域
          移动端: 默认收起，点击"筛选"展开

Step 2.4  创建 SwipeableContainer 组件
          路径: src/components/ui/SwipeableContainer.tsx
          功能: 提供 onSwipeLeft / onSwipeRight 回调
          用途: Tab 切换、列表项操作
```

### Phase 3：页面级适配 (P0 Pages)

```
Step 3.1  适配 LoginPage
          - 验证现有响应式是否满足
          - 添加 safe-area padding
          - 确保键盘弹出时表单不被遮挡

Step 3.2  适配 AgentLauncherPage
          - 使用 ResponsiveGrid 替代内联 grid
          - 移动端单列展示 Agent 卡片
          - 调整卡片尺寸和间距

Step 3.3  适配 AiChatPage
          - 移动端隐藏侧面板（设置/附件）
          - 全屏对话视图
          - 浮动按钮打开设置 (BottomSheet)
          - 输入框 sticky 底部 + safe-area
          - 消息气泡最大宽度调整
```

### Phase 4：页面级适配 (P1 Pages)

```
Step 4.1  适配 UsersPage
          - 使用 SearchFilterBar + ResponsiveGrid
          - 移动端 2 列用户卡片

Step 4.2  适配 LlmLogsPage
          - CollapsibleFilterPanel 替代现有筛选栏
          - 日志项改为卡片视图
          - 详情弹窗使用 ResponsiveDialog

Step 4.3  适配 LandingPage
          - 验证并微调 Hero section 间距
          - 确保 CTA 按钮触控友好 (48px min)
```

### Phase 5：页面级适配 (P2 Pages)

```
Step 5.1  适配 ModelManageTabsPage
          - TabBar 横向滚动
          - 模型列表改卡片视图

Step 5.2  适配 PromptStagesPage
          - 提示词列表单列
          - 编辑弹窗 → BottomSheet

Step 5.3  适配 AuthzPage
          - 移动端改为：角色列表 → 点击 → 权限详情页
          - 放弃矩阵视图

Step 5.4  适配 ExecutiveDashboardPage
          - KPI 卡片单列堆叠
          - 图表全宽显示
```

### Phase 6：交互增强 (Touch & Gesture)

```
Step 6.1  替换所有 hover 交互
          - onMouseEnter/Leave → onClick toggle 或 long-press
          - 检索所有 hover 依赖并替换

Step 6.2  添加触控反馈
          - :active 状态替代 :hover
          - 添加 tap highlight color
          - 按钮/卡片添加 press 缩放动画

Step 6.3  手势支持
          - 侧边栏：右滑打开 MobileDrawer
          - 对话页：左滑返回
          - 列表项：滑动删除/操作
```

---

## 五、检测与验证方式

### 5.1 自动化检测

#### A. 视口断点覆盖测试

```typescript
// tests/responsive.spec.ts (Playwright)
const viewports = [
  { name: 'iPhone SE',       width: 375,  height: 667  },
  { name: 'iPhone 14 Pro',   width: 393,  height: 852  },
  { name: 'iPad Mini',       width: 768,  height: 1024 },
  { name: 'iPad Pro 11',     width: 834,  height: 1194 },
  { name: 'Desktop 1080p',   width: 1920, height: 1080 },
];

for (const vp of viewports) {
  test(`${vp.name}: 页面无水平溢出`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/agent-launcher');
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(vp.width);
  });
}
```

#### B. 触控可达性测试

```typescript
test('所有可交互元素 ≥ 44px 触控区域', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const buttons = await page.locator('button, a, [role="button"]').all();
  for (const btn of buttons) {
    const box = await btn.boundingBox();
    if (box && box.width > 0) {
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
  }
});
```

#### C. CSS 溢出检测

```typescript
test('无元素水平溢出', async ({ page }) => {
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('*')).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.right > vw + 1 || rect.left < -1;
    }).map(el => ({
      tag: el.tagName,
      class: el.className?.toString().slice(0, 80),
      right: Math.round(el.getBoundingClientRect().right),
    }));
  });
  expect(overflowing).toHaveLength(0);
});
```

### 5.2 手动验证清单

#### 通用检查点

- [ ] **无水平滚动**：所有页面在 375px 宽度下无水平滚动条
- [ ] **触控目标**：所有可点击元素最小 44×44px
- [ ] **文字可读性**：最小字号 ≥ 14px（移动端正文）
- [ ] **间距合理**：元素间距在移动端不过于拥挤或稀疏
- [ ] **safe-area**：在有刘海/底部横条的设备上内容不被遮挡
- [ ] **键盘弹出**：输入框获得焦点时页面正确滚动，不被键盘遮挡
- [ ] **横竖屏切换**：旋转设备后布局正常重排
- [ ] **手势冲突**：无系统手势（返回/前进）与应用手势冲突

#### 导航检查

- [ ] Hamburger 菜单正常打开/关闭
- [ ] 底部 Tab 栏显示且可切换
- [ ] 当前路由在 Tab 栏正确高亮
- [ ] MobileDrawer 可通过手势滑动关闭

#### 弹窗检查

- [ ] Dialog 在移动端自动切换为 BottomSheet
- [ ] BottomSheet 可拖拽关闭
- [ ] BottomSheet 内容可滚动（长表单时）
- [ ] 多层弹窗正确堆叠

### 5.3 浏览器 DevTools 检测

```
Chrome DevTools 检测流程：
1. F12 → Toggle device toolbar (Ctrl+Shift+M)
2. 选择设备：iPhone 14 Pro / iPad Mini
3. 逐页面检查：
   a. 打开 Console，粘贴溢出检测脚本：
      document.querySelectorAll('*').forEach(el => {
        if (el.getBoundingClientRect().right > window.innerWidth)
          console.warn('溢出:', el.tagName, el.className);
      })
   b. 检查 Network → 确认无不必要的桌面端资源加载
   c. Performance → 检查移动端渲染帧率 ≥ 30fps
```

### 5.4 Lighthouse 移动端审计

```bash
# 移动端 Lighthouse 审计
npx lighthouse http://localhost:5173/agent-launcher \
  --form-factor=mobile \
  --screenEmulation.width=375 \
  --screenEmulation.height=667 \
  --only-categories=performance,accessibility \
  --output=html \
  --output-path=./reports/mobile-audit.html
```

**关注指标**：
- Performance Score ≥ 70
- Tap targets sized appropriately ✅
- Content sized to viewport ✅
- Font sizes legible ✅

---

## 六、需要执行的标准 Skills

### 6.1 开发阶段

| Skill | 触发时机 | 用途 |
|-------|----------|------|
| **`/verify`** (human-verify) | 每个 Phase 完成后 | 多角度验证适配效果：逆向验证（缩小窗口看是否溢出）、边界测试（极端宽度 320px/414px）、用户场景模拟（单手操作流程） |
| **`/fix-unused-imports`** | 每次大批量组件创建后 | 清理新增公共组件导入后可能产生的未使用导入（旧组件被 ResponsiveGrid 等替代后） |
| **`/smoke-test`** | Phase 1 完成后 | 验证 API 层未因布局改动产生回归（Controller 端点仍正常响应） |

### 6.2 发版阶段

| Skill | 触发时机 | 用途 |
|-------|----------|------|
| **`/release-version`** | 每个 Phase 合并后 | 按 Phase 粒度发版：Phase 0-1 = minor (布局基础设施)，Phase 2-6 = patch (逐步适配) |

### 6.3 质量保障

| Skill | 触发时机 | 用途 |
|-------|----------|------|
| **`/verify`** | PR 提交前 | 最终全量验证：遍历所有 P0/P1 页面在 3 种设备尺寸下的表现 |
| **`/smoke-test`** | 发版后 | 线上冒烟测试确保功能不受影响 |

---

## 七、技术约束与注意事项

### 7.1 不做的事情

- **不做独立移动端应用** — 同一套代码，响应式适配
- **不引入新 CSS 框架** — 继续使用 Tailwind v4
- **不改变路由结构** — 移动端和桌面端共享路由
- **P3 页面暂不适配** — 画布编辑器、模型池策略等重度交互页面显示"请使用桌面端"提示
- **不破坏已有桌面端体验** — 所有改造必须向后兼容

### 7.2 性能约束

- 移动端默认启用性能模式（自动检测 `navigator.maxTouchPoints > 0` 且 `window.innerWidth < 768`）
- 新增组件的 JS Bundle ≤ 15KB gzipped（BottomSheet + MobileDrawer + MobileTabBar 合计）
- 避免在移动端加载 Three.js 3D 组件（按需加载）

### 7.3 兼容性要求

| 平台 | 最低版本 |
|------|----------|
| iOS Safari | 15.0+ |
| Android Chrome | 90+ |
| 微信内置浏览器 | WebView 91+ |

### 7.4 设计规范（移动端）

| 属性 | 值 |
|------|-----|
| 最小触控目标 | 44 × 44 px |
| 正文字号 | 14px - 16px |
| 标题字号 | 18px - 24px |
| 页面边距 | 16px (xs) / 20px (sm) |
| 卡片圆角 | 12px (移动端) / 14-16px (桌面端) |
| 底部 Tab 栏高度 | 56px + safe-area-inset-bottom |
| 顶部导航高度 | 48px + safe-area-inset-top |

---

## 八、工作量估算与里程碑

| Phase | 内容 | 涉及文件数 | 里程碑产物 |
|-------|------|-----------|-----------|
| **Phase 0** | 基础设施 | ~5 个新建/修改 | `useBreakpoint` + layoutStore 扩展 + CSS Token |
| **Phase 1** | 核心布局 | ~8 个新建/修改 | AppShell 移动端导航可用 |
| **Phase 2** | 公共组件 | ~6 个新建 | ResponsiveGrid / SearchFilterBar / BottomSheet 就绪 |
| **Phase 3** | P0 页面 | ~5 个修改 | Login + AgentLauncher + AiChat 移动端可用 |
| **Phase 4** | P1 页面 | ~4 个修改 | Users + LlmLogs + Landing 移动端可用 |
| **Phase 5** | P2 页面 | ~6 个修改 | 其余管理页面移动端可用 |
| **Phase 6** | 交互增强 | ~15 个修改 | 全站触控 + 手势支持 |

**总计**：约 49 个文件新建/修改，9 个新公共组件，7 个现有组件改造。

---

## 附录：公共组件 API 设计草案

### useBreakpoint

```typescript
type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

interface BreakpointState {
  breakpoint: Breakpoint;
  isMobile: boolean;   // < 768px
  isTablet: boolean;   // 768px - 1023px
  isDesktop: boolean;  // ≥ 1024px
  width: number;       // 当前视口宽度
}

function useBreakpoint(): BreakpointState;
```

### BottomSheet

```typescript
interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children: ReactNode;
  height?: 'auto' | 'half' | 'full';    // 默认 'auto'
  showDragHandle?: boolean;               // 默认 true
  dismissible?: boolean;                  // 默认 true (手势下滑关闭)
}
```

### ResponsiveGrid

```typescript
interface ResponsiveGridProps {
  children: ReactNode;
  cols?: { xs?: number; sm?: number; md?: number; lg?: number; xl?: number };
  gap?: number | string;           // 默认 16px
  loading?: boolean;
  skeletonCount?: number;          // 默认 6
  skeletonHeight?: number;         // 默认 120px
  className?: string;
}

// 使用示例
<ResponsiveGrid cols={{ xs: 1, sm: 2, lg: 3, xl: 4 }} loading={loading}>
  {items.map(item => <GlassCard key={item.id} .../>)}
</ResponsiveGrid>
```

### ResponsiveDialog

```typescript
interface ResponsiveDialogProps {
  // 与现有 Dialog 完全相同的 Props
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: string;
  content: ReactNode;
  maxWidth?: number | string;
  // 移动端特有
  mobileHeight?: 'auto' | 'half' | 'full';
}

// 内部逻辑
// isMobile ? <BottomSheet {...props} /> : <Dialog {...props} />
```
