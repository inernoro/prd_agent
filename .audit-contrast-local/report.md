# 全站双主题对比度审计（本地 dist + API 桩）

站点 http://127.0.0.1:5673｜路由 48 条｜命中 115 处｜配色组 93

> 本轮用空数据桩，覆盖外壳/导航/按钮/图标/空状态；列表被真实数据填满后的行需用远端版复扫。

## 按配色聚合（影响路由数从多到少）

| 影响路由数 | 类型 | 前景 | 背景 | 实测 | 需要 | 样例元素 |
|---|---|---|---|---|---|---|
| 2 | text | `rgb(85, 85, 85)` | `rgb(146,64,14)` | 1.05:1 | 4.5:1 | `div.flex-1.min-h-0>div.h-full.flex-1>div.flex-1.min-h-0>div` |
| 2 | text | `rgb(255, 255, 255)` | `rgb(238,234,227)` | 1.2:1 | 4.5:1 | `div>div>div>button` |
| 2 | text | `rgb(147, 197, 253)` | `rgb(196,229,252)` | 1.37:1 | 4.5:1 | `div.pa-agent-main.flex-1>div.shrink-0.flex>div.hidden.md:flex>button.pa-toolbar-btn.pa-toolbar-font-btn` |
| 2 | text | `rgba(199, 210, 254, 0.38)` | `rgb(64,67,83)` | 2.28:1 | 4.5:1 | `header.relative.shrink-0>div.flex.flex-col>div.flex.flex-wrap>span.fea-subtitle-muted` |
| 2 | text | `rgb(107, 114, 128)` | `rgb(183,184,212)` | 2.49:1 | 4.5:1 | `div.pa-agent-sidebar.flex>div.flex-1.overflow-auto>div.text-xs.text-center>span.text-[10px].opacity-70` |
| 2 | text | `rgba(199, 210, 254, 0.38)` | `rgb(43,45,56)` | 2.6:1 | 4.5:1 | `header.relative.shrink-0>div.flex.flex-col>div.min-w-0>p.mt-1.text-xs` |
| 2 | text | `rgba(199, 210, 254, 0.38)` | `rgb(17,20,42)` | 2.78:1 | 4.5:1 | `div.relative.flex-1>aside.min-h-0.flex>div.fea-aside-hint.hidden>p.text-[11px].leading-5` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.42)` | `rgb(56,57,47)` | 3.45:1 | 4.5:1 | `main.relative.flex>div.flex.flex-wrap>div.min-w-0>div.mt-1.truncate` |
| 2 | text | `oklab(0.894 0.0225306 -0.0523581 / 0.45)` | `rgb(29,27,57)` | 3.48:1 | 4.5:1 | `div.space-y-3>button.fea-rail-card.w-full>div.mt-3.space-y-1.5>p.text-[10px].text-violet-200/45` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.38)` | `rgb(25,25,26)` | 3.55:1 | 4.5:1 | `div.mx-auto.grid>aside.min-h-0.overflow-hidden>div.h-[calc(100%-116px)].space-y-3>div.flex.h-full` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.4)` | `rgb(28,28,29)` | 3.75:1 | 4.5:1 | `div.mt-4.space-y-3>div.flex.gap-2.5>div.min-w-0>div.mt-0.5.line-clamp-2` |
| 2 | text | `oklab(0.87 0.00457833 -0.0648386 / 0.5)` | `rgb(17,15,35)` | 3.91:1 | 4.5:1 | `div.shrink-0>div.space-y-3>button.fea-rail-card.w-full>p.relative.mt-2` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.42)` | `rgb(28,28,29)` | 4.02:1 | 4.5:1 | `div.border-b.border-token-subtle>div.flex.items-center>div>div.mt-1.text-xs` |
| 2 | text | `oklab(0.999994 0.0000455678 0.0000200868 / 0.42)` | `rgb(17,17,18)` | 4.04:1 | 4.5:1 | `div.mx-auto.mt-4>div.flex.h-full>div>div.mt-2.text-sm` |
| 2 | text | `rgb(107, 114, 128)` | `rgb(244,245,248)` | 4.43:1 | 4.5:1 | `div.pa-agent-root.h-full>div.pa-agent-sidebar.flex>div.flex-1.overflow-auto>div.text-xs.text-center` |
| 2 | text | `rgba(199, 210, 254, 0.55)` | `rgb(16,16,18)` | 4.48:1 | 4.5:1 | `header.relative.shrink-0>div.mt-4.flex>button.fea-task-pill.inline-flex>span.text-xs.font-medium` |
| 1 | icon | `rgba(15, 23, 42, 0.68)` | `rgb(15,24,33)` | 1:1 | 3:1 | `div.relative.z-10>div.px-3.pb-2>div.flex.items-center>svg.lucide.lucide-search` |
| 1 | icon | `rgba(15, 23, 42, 0.68)` | `rgb(19,22,30)` | 1.01:1 | 3:1 | `div.flex.items-center>div.relative>button.flex.items-center>svg.lucide.lucide-chevron-down` |
| 1 | text | `rgb(15, 23, 42)` | `rgb(19,22,30)` | 1.01:1 | 4.5:1 | `div.flex.items-center>div.relative>button.flex.items-center>span` |
| 1 | text | `oklch(0.894 0.057 293.283)` | `rgb(224,215,253)` | 1.01:1 | 4.5:1 | `main.flex-1.min-h-0>div.h-full.min-h-[400px]>p.mt-2.max-w-md>span.text-violet-200.mx-1` |
| 1 | icon | `oklab(0.845 -0.138113 0.0370641 / 0.8)` | `rgb(119,230,187)` | 1.01:1 | 3:1 | `main.flex-1.min-h-0>div.max-w-3xl.mx-auto>button.w-full.px-4>svg.lucide.lucide-book-open` |
| 1 | icon | `oklab(0.894 0.0225306 -0.0523581 / 0.8)` | `rgb(219,216,210)` | 1.02:1 | 3:1 | `div.max-w-3xl.mx-auto>label.relative.block>div.px-6.py-7>svg.lucide.lucide-upload` |
| 1 | icon | `oklch(0.87 0.065 274.039)` | `rgb(217,212,224)` | 1.03:1 | 3:1 | `header.shrink-0.flex>div.flex.items-start>div.rounded-2xl.border>svg.lucide.lucide-file-text` |
| 1 | text | `rgba(15, 23, 42, 0.68)` | `rgb(10,14,21)` | 1.05:1 | 4.5:1 | `div.relative.flex>div.relative.z-10>div.flex-1.overflow-y-auto>div.text-center.py-8` |
| 1 | icon | `oklch(0.879 0.169 91.605)` | `rgb(222,219,213)` | 1.05:1 | 3:1 | `div.bg-token-nested.border>div.flex.items-center>h2.text-sm.font-semibold>svg.lucide.lucide-sparkles` |
| 1 | text | `rgba(15, 23, 42, 0.78)` | `rgb(13,11,22)` | 1.06:1 | 4.5:1 | `div.flex.items-center>div.flex.items-center>div>div.text-xs.text-token-secondary` |
| 1 | icon | `rgba(15, 23, 42, 0.78)` | `rgb(13,11,22)` | 1.06:1 | 3:1 | `div.max-w-6xl.mx-auto>div.flex.items-center>button.p-2.rounded-lg>svg.lucide.lucide-arrow-left` |
| 1 | icon | `rgba(15, 23, 42, 0.68)` | `rgb(13,11,22)` | 1.06:1 | 3:1 | `div.grid.grid-cols-1>div>div.rounded-xl.border>svg.lucide.lucide-inbox` |
| 1 | text | `oklab(0.879 -0.00473352 0.168934 / 0.8)` | `rgb(224,221,211)` | 1.06:1 | 4.5:1 | `aside.flex.flex-col>section.bg-token-nested.border>div.space-y-4>p.text-[11px].text-amber-300/80` |
| 1 | text | `rgb(15, 23, 42)` | `rgb(13,11,22)` | 1.09:1 | 3:1 | `div.flex.items-center>div.flex.items-center>div>div.text-xl.font-bold` |
| 1 | icon | `oklch(0.828 0.111 230.318)` | `rgb(180,217,231)` | 1.11:1 | 3:1 | `div.h-full.min-h-0>header.shrink-0.flex>div.w-10.h-10>svg.lucide.lucide-mail` |
| 1 | icon | `oklab(0.828 -0.0708764 -0.0854256 / 0.85)` | `rgb(185,220,234)` | 1.13:1 | 3:1 | `div.h-full.min-h-0>header.shrink-0.flex>button.shrink-0.h-8>svg.lucide.lucide-circle-help` |
| 1 | text | `oklch(0.962 0.059 95.617)` | `rgb(234,229,221)` | 1.13:1 | 4.5:1 | `div.rounded-[16px].relative>div.min-h-0.flex-1>div.rounded-xl.border>div.rounded-lg.border` |
| 1 | icon | `oklab(0.811 0.0443873 -0.101739 / 0.8)` | `rgb(211,199,247)` | 1.14:1 | 3:1 | `div.relative>div.mt-1.5.flex>button.inline-flex.items-center>svg.lucide.lucide-clipboard-paste` |
| 1 | icon | `rgba(167, 243, 208, 0.9)` | `rgb(248,245,239)` | 1.16:1 | 3:1 | `section.rounded-xl.p-5>div.flex.items-center>div.flex.items-center>svg.lucide.lucide-message-square` |
| 1 | text | `rgb(255, 255, 255)` | `rgb(234,239,246)` | 1.16:1 | 4.5:1 | `div.pa-agent-main.flex-1>div.flex-1.overflow-hidden>div.flex.flex-col>button.flex.items-center` |
| 1 | text | `rgb(196, 181, 253)` | `rgb(218,200,244)` | 1.19:1 | 4.5:1 | `div.rounded-2xl.p-5>div.flex.flex-col>div.flex.items-baseline>span.inline-flex.items-center` |
| 1 | icon | `rgb(255, 255, 255)` | `rgb(238,234,227)` | 1.2:1 | 3:1 | `div>div>button>svg.lucide.lucide-plus` |
| 1 | text | `rgb(255, 255, 255)` | `rgb(230,234,246)` | 1.2:1 | 4.5:1 | `div.pa-agent-main.flex-1>div.shrink-0.flex>div.flex.items-center>button.pa-tab-button.flex` |
| 1 | text | `rgb(255, 255, 255)` | `rgb(230,233,247)` | 1.21:1 | 4.5:1 | `div.pa-agent-main.flex-1>div.shrink-0.flex>div.flex.items-center>button.pa-tab-button.flex` |