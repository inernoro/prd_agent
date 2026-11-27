# 可复用组件（prd-admin 正式源码）

| 组件 | 路径 | 用途 |
|---|---|---|
| AppShell | src/layouts/AppShell.tsx | 应用外壳、左侧导航、移动端抽屉与底栏 |
| Button | src/components/design/Button.tsx | 按钮：primary / secondary / ghost / danger，xs / sm / md |
| Badge | src/components/design/Badge.tsx | 状态标签：subtle / success / danger / warning / new |
| GlassCard | src/components/design/GlassCard.tsx | 卡片表面 |
| SegmentedTabs | src/components/design/SegmentedTabs.tsx | 二到四项切换 |
| SplitToTabLayout | src/components/design/SplitToTabLayout.tsx | 桌面两栏、移动端页签 |
| Switch | src/components/design/Switch.tsx | 开关 |
| MapSpinner | src/components/ui/VideoLoader.tsx | 行内加载 |
| Dialog / BottomSheet | src/components/ui/Dialog.tsx、BottomSheet.tsx | 弹窗与移动端底部面板 |
| toast | src/lib/toast | 轻提示 |
| navRegistry | src/app/navRegistry.tsx | 路由与百宝箱入口登记 |
| apiRequest | src/services/real/apiClient.ts | JSON 请求 |