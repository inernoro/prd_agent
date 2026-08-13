# 全站双主题对比度审计（本地 dist + API 桩）

站点 http://127.0.0.1:5673｜路由 48 条｜命中 522 处｜配色组 113

> 本轮用空数据桩，覆盖外壳/导航/按钮/图标/空状态；列表被真实数据填满后的行需用远端版复扫。

## 按配色聚合（影响路由数从多到少）

| 影响路由数 | 类型 | 前景 | 背景 | 实测 | 需要 | 样例元素 |
|---|---|---|---|---|---|---|
| 91 | text | `rgb(226, 232, 240)` | `rgb(187,119,60)` | 2.93:1 | 4.5:1 | `#bt-branch-badge>span` |
| 91 | icon | `rgb(226, 232, 240)` | `rgb(187,119,60)` | 2.93:1 | 3:1 | `#bt-branch-badge>svg.lucide.lucide-git-branch` |
| 47 | text | `rgb(226, 232, 240)` | `rgb(190,125,69)` | 2.74:1 | 4.5:1 | `#bt-branch-badge>span.bg-token-nested` |
| 44 | text | `rgb(226, 232, 240)` | `rgb(180,115,58)` | 3.12:1 | 4.5:1 | `#bt-branch-badge>span.bg-token-nested` |
| 4 | text | `rgb(255, 255, 255)` | `rgb(238,234,227)` | 1.2:1 | 3:1 | `div.w-full>div.text-center.mb-8>div.map-reveal-active>h2.text-white.font-medium` |
| 2 | text | `rgba(15, 23, 42, 0.78)` | `rgb(10,10,12)` | 1.08:1 | 4.5:1 | `button.fea-rail-card.w-full>div.mt-3.space-y-1.5>div.text-[11px].text-token-secondary>span.text-token-secondary` |
| 2 | text | `rgb(15, 23, 42)` | `rgb(10,10,12)` | 1.11:1 | 4.5:1 | `div.flex.items-center>div.min-w-0>div.flex.items-center>h3.text-sm.font-semibold` |
| 2 | icon | `rgb(255, 255, 255)` | `rgb(238,234,227)` | 1.2:1 | 3:1 | `div.pa-agent-sidebar.flex>div.shrink-0.flex>button.p-1.5.rounded-lg>svg.lucide.lucide-plus` |
| 2 | text | `rgb(85, 85, 85)` | `rgb(30,30,30)` | 2.24:1 | 4.5:1 | `div.flex-1.min-h-0>div.h-full.flex-1>div.flex-1.min-h-0>div` |
| 2 | text | `rgba(199, 210, 254, 0.38)` | `rgb(10,10,12)` | 2.72:1 | 4.5:1 | `header.relative.shrink-0>div.flex.flex-col>div.min-w-0>p.mt-1.text-xs` |
| 2 | text | `rgba(199, 210, 254, 0.38)` | `rgb(12,12,19)` | 2.74:1 | 4.5:1 | `div.relative.flex-1>aside.min-h-0.flex>div.fea-aside-hint.hidden>p.text-[11px].leading-5` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.38)` | `rgb(30,30,31)` | 3.52:1 | 4.5:1 | `div.mx-auto.grid>aside.min-h-0.overflow-hidden>div.h-[calc(100%-116px)].space-y-3>div.flex.h-full` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.38)` | `rgb(25,25,26)` | 3.55:1 | 4.5:1 | `aside.min-h-0.overflow-hidden>div.flex.items-center>div.min-w-0>div.mt-0.5.truncate` |
| 2 | text | `oklab(0.894 0.0225306 -0.0523581 / 0.45)` | `rgb(10,10,12)` | 3.56:1 | 4.5:1 | `div.space-y-3>button.fea-rail-card.w-full>div.mt-3.space-y-1.5>p.text-[10px].text-violet-200/45` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.4)` | `rgb(28,28,29)` | 3.75:1 | 4.5:1 | `div.mt-4.space-y-3>div.flex.gap-2.5>div.min-w-0>div.mt-0.5.line-clamp-2` |
| 2 | text | `rgb(255, 255, 255)` | `rgb(151,96,255)` | 3.87:1 | 4.5:1 | `div.flex-1.min-h-0>div.h-full.min-h-0>header.shrink-0.px-6>button.inline-flex.items-center` |
| 2 | text | `oklab(0.87 0.00457833 -0.0648386 / 0.5)` | `rgb(10,10,12)` | 3.92:1 | 4.5:1 | `div.shrink-0>div.space-y-3>button.fea-rail-card.w-full>p.relative.mt-2` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.42)` | `rgb(28,28,29)` | 4.02:1 | 4.5:1 | `div.border-b.border-token-subtle>div.flex.items-center>div>div.mt-1.text-xs` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.42)` | `rgb(17,17,18)` | 4.04:1 | 4.5:1 | `main.relative.flex>div.flex.flex-wrap>div.min-w-0>div.mt-1.truncate` |
| 2 | text | `rgb(255, 255, 255)` | `rgb(124,92,255)` | 4.35:1 | 4.5:1 | `div.tt-root>div.tt-empty>div.tt-empty-row>button.tt-btn.tt-primary` |
| 2 | text | `rgba(199, 210, 254, 0.55)` | `rgb(19,19,21)` | 4.43:1 | 4.5:1 | `header.relative.shrink-0>div.mt-4.flex>button.fea-task-pill.inline-flex>span.text-xs.font-medium` |
| 1 | text | `oklch(0.929 0.013 255.508)` | `rgb(233,230,224)` | 1.01:1 | 4.5:1 | `div.text-center.mb-8>div.map-reveal-active>div.inline-flex.items-center>span.text-[12px].text-slate-200` |
| 1 | icon | `oklch(0.929 0.013 255.508)` | `rgb(233,230,224)` | 1.01:1 | 3:1 | `div.text-center.mb-8>div.map-reveal-active>div.inline-flex.items-center>svg.lucide.lucide-swords` |
| 1 | text | `rgb(237, 235, 230)` | `rgb(238,234,227)` | 1.01:1 | 3:1 | `div.flex-1.min-h-0>div.tt-root>div.tt-empty>h2` |
| 1 | text | `rgba(15, 23, 42, 0.68)` | `rgb(15,15,20)` | 1.04:1 | 4.5:1 | `section.fea-panel.min-h-0>div.fea-panel-header.shrink-0>div.min-w-0>p.text-[11px].text-token-muted` |
| 1 | icon | `rgba(15, 23, 42, 0.68)` | `rgb(15,15,20)` | 1.04:1 | 3:1 | `section.fea-panel.min-h-0>div.flex-1.min-h-0>div.h-full.min-h-[240px]>svg.lucide.lucide-code-xml` |
| 1 | text | `rgba(15, 23, 42, 0.78)` | `rgb(15,15,20)` | 1.05:1 | 4.5:1 | `section.fea-panel.min-h-0>div.flex-1.min-h-0>div.flex.flex-wrap>button.fea-btn.h-8` |
| 1 | icon | `rgba(15, 23, 42, 0.78)` | `rgb(15,15,20)` | 1.05:1 | 3:1 | `div.flex-1.min-h-0>div.flex.flex-wrap>button.fea-btn.h-8>svg.lucide.lucide-file-text` |
| 1 | icon | `oklab(0.894 0.0225306 -0.0523581 / 0.8)` | `rgb(229,225,219)` | 1.05:1 | 3:1 | `div.max-w-3xl.mx-auto>label.relative.block>div.px-6.py-7>svg.lucide.lucide-upload` |
| 1 | text | `rgba(15, 23, 42, 0.68)` | `rgb(10,10,12)` | 1.06:1 | 4.5:1 | `div.space-y-3>button.fea-rail-card.w-full>div.relative.mt-3>span.text-[10px].text-token-muted` |
| 1 | text | `rgb(255, 255, 255)` | `rgb(250,248,246)` | 1.06:1 | 4.5:1 | `div.pa-agent-main.flex-1>div.shrink-0.flex>div.flex.items-center>button.pa-tab-button.flex` |
| 1 | icon | `rgb(255, 255, 255)` | `rgb(250,248,246)` | 1.06:1 | 3:1 | `div.shrink-0.flex>div.flex.items-center>button.pa-tab-button.flex>svg.lucide.lucide-message-square` |
| 1 | text | `rgba(15, 23, 42, 0.78)` | `rgb(13,11,22)` | 1.06:1 | 4.5:1 | `div.flex.items-center>div.flex.items-center>div>div.text-xs.text-token-secondary` |
| 1 | icon | `rgba(15, 23, 42, 0.78)` | `rgb(13,11,22)` | 1.06:1 | 3:1 | `div.max-w-6xl.mx-auto>div.flex.items-center>button.p-2.rounded-lg>svg.lucide.lucide-arrow-left` |
| 1 | icon | `rgba(15, 23, 42, 0.68)` | `rgb(13,11,22)` | 1.06:1 | 3:1 | `div.grid.grid-cols-1>div>div.rounded-xl.border>svg.lucide.lucide-inbox` |
| 1 | text | `rgb(15, 23, 42)` | `rgb(15,15,20)` | 1.07:1 | 4.5:1 | `section.fea-panel.min-h-0>div.fea-panel-header.shrink-0>div.min-w-0>h2.text-sm.font-medium` |
| 1 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.45)` | `rgb(238,234,227)` | 1.08:1 | 4.5:1 | `div.w-full>div.map-reveal-active>div.text-center.mt-3>span.text-[11px].text-white/45` |
| 1 | icon | `rgba(15, 23, 42, 0.78)` | `rgb(10,10,12)` | 1.08:1 | 3:1 | `div.fixed.top-4>div.pointer-events-auto.min-w-[320px]>button.flex-shrink-0.p-1>svg.lucide.lucide-x` |
| 1 | text | `rgb(15, 23, 42)` | `rgb(13,11,22)` | 1.09:1 | 3:1 | `div.flex.items-center>div.flex.items-center>div>div.text-xl.font-bold` |
| 1 | text | `rgb(36, 25, 21)` | `rgb(33,36,43)` | 1.1:1 | 4.5:1 | `div.relative.z-10>div.p-3.flex-shrink-0>button.group.relative>span` |