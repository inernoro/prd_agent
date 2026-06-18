| fix | prd-admin | 修复液态玻璃在性能模式下两处边界:① 头像菜单「液态玻璃」徽章改用 shouldReduceEffects 判定,auto 在 Windows 自动降级时正确显示「已关闭」;② 玻璃关闭(backdrop-filter 被清)时弹窗面板恢复近实底背景+遮罩回退 rgba(0,0,0,0.72),避免半透失焦 |
