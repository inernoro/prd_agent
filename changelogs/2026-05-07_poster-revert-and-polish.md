| fix | prd-admin | 海报编辑页缩放预览改用 transform:scale 而非缩小容器宽度，内部 DOM 永远在 1200×628 设计稿尺寸下渲染（vw 字号在容器内永远准确），76% 缩放下不再溢出也不再"更丑"；回滚上一轮的 cqw 改动 |
| fix | prd-admin | 海报缩略图（页面列表 / 素材卡 / 生成页卡）禁用 autoPlay loop，改用 preload="metadata" 仅取首帧当封面，多卡同屏不再消耗大量 CPU/GPU |
| fix | prd-admin | 海报编辑页主画布大图视频也改 preload="metadata"，避免编辑页一直在后台播放视频 |
| feat | prd-admin | 首页海报弹窗改为"每会话只弹一次"：弹出 1.5s 后自动登记已看过到 sessionStorage，同会话再进主页不重弹；浏览器关闭后下次登录视为新会话 |
| feat | prd-admin | AutoPublishDialog 立即执行后会轮询执行状态最多 60 秒，把首个失败节点的错误（节点名 + 错误信息）直接 toast 给用户，不再"秒过黑盒" |
