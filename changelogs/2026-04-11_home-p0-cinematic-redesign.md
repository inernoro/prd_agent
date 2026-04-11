| refactor | prd-admin | 首页 /home Hero 精简到"一屏一主角"（删除 10+ 堆料元素，保留超大显示标题 + 单行副标 + 双 CTA + scroll 提示） |
| feat | prd-admin | 新增 SignatureCinema 幕（全宽 16:9 电影位），预留视频 src 入口，缺失时降级为径向渐变 poster + 播放图标 + "即将上线"签名 |
| feat | prd-admin | LandingPage 接入 IntersectionObserver 滚动场景编排：Hero/Showcase/Cinema/Library/Features/Evidence/Download/CTA 八幕各自对应一种 Starfield themeColor，粒子宇宙随叙事流动 |
| feat | prd-admin | 引入 Space Grotesk + Inter 作为品牌显示/正文字体（Google Fonts 非阻塞加载，新增 --font-display / --font-body CSS tokens） |
| refactor | prd-admin | 顶栏导航增加「片花」入口，删除「案例」，观看片花 CTA 现在滚到 #cinema 与标签语义一致 |
