| refactor | prd-admin | 首页 /home 背景彻底改为静态：新增 StaticBackdrop 组件（纯 CSS，零动画零粒子零 canvas），参照 Linear.app + Vercel.com 做法 |
| feat | prd-admin | StaticBackdrop 五层：#050508 纯底 / 32px 点阵网格（顶浓底淡 mask）/ 顶部紫色径向光晕 / 底部玫瑰微光 / 细噪点 overlay |
| refactor | prd-admin | 删除 StarfieldBackground.tsx（WebGL 粒子连线 shader），LandingPage 移除场景色编排 IntersectionObserver 逻辑（静态背景无需切换色温） |
| refactor | prd-admin | HeroSection 移除本地顶部径向光晕，统一由 StaticBackdrop 提供，避免两层叠加 |
