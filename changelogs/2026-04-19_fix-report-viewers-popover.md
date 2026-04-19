| fix | prd-admin | 修复周报详情页「已阅」浏览记录弹窗样式错乱：改用 createPortal 挂到 body，布局关键尺寸走 inline style，滚动容器补 min-height:0 + overscrollBehavior:contain，新增 ESC 与遮罩点击关闭 |
| fix | prd-admin | 加强周报浏览记录弹窗边界感：硬编码不透明深灰底色 + backdrop-blur(20px) + 强阴影 + 半透明 scrim 遮罩，列表项加细边框与 hover 高亮，header 加分隔线 |
