| feat | prd-admin | 新增 `components/daily-tips/TipCard.tsx` 共享教程卡片组件,借鉴文学创作锚点教程气泡样式(MapPin 图标 + emerald accent + 知道啦 CTA);支持 `bubble` / `card` 两种 variant、`ack` 模式(「知道啦」按钮)、自定义 accent / 图标 / 关闭 |
| refactor | prd-admin | `TipsDrawer` 抽屉内的每条 tip 改用 `TipCard` 组件渲染,视觉跟文学创作锚点教程统一;非定向 tip 默认绿色 accent,定向(isTargeted)用红紫 |
| refactor | prd-admin | `ArticleIllustrationEditorPage` 的「手动指定配图位置」锚点教程气泡改用 `TipCard` 组件,不再硬编码玻璃面板样式;彻底合并两个独立的教程 UI 实现 |
| feat | prd-admin | 悬浮组整体折叠:TipsDrawer 书图标 hover 时左侧出现「EyeOff」小把手,点一下把书 + AppShell 通知铃铛一起收到屏幕右边缘(只露半截 + 半透明);鼠标贴右下 140×200px 区域自动滑回,点任一按钮也召回 |
| feat | prd-admin | 新用户兜底自动弹:本 session 首次访问且有任意 tip 时,书自动展开一次抽屉,让用户第一次看到就知道是什么;用 `tipsBookFirstVisitShown` sessionStorage 记忆 |
| feat | prd-admin | AppShell 订阅 `floating-dock-collapsed-changed` 自定义事件 + `floatingDockCollapsed` sessionStorage,toast 通知按钮跟随折叠状态改变位置与透明度,两个悬浮按钮实现「整体折叠」联动 |
