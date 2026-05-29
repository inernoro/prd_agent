| fix | prd-admin | MarkdownViewer 给正文容器加 userSelect:'text'，防止任何祖先 user-select:none 让划词选区瞬间清空（分享视图划词评论修复） |
| feat | prd-admin | DocBrowser 进入条目时预拉评论计数，正文上方常驻「N 条评论」chip 入口，让分享视图也能直接看到「这里有 N 条别人留的评论」 |
| feat | prd-admin | 新增 components/ui/ImageLightbox.tsx 通用图片灯箱：createPortal + z-[10000] + 左右切换 + Esc/蒙版关 + 下载 + 计数指示 |
| feat | prd-admin | MarkdownViewer 集成 ImageLightbox：md 中的图片点击放大，整篇所有图片可 ← → 切换浏览（cursor:zoom-in 提示） |
| fix | prd-api | DocumentStoreController.CreateInlineComment 放宽权限：私有库但有活跃分享链时，登录用户也可评论（验收报告分享场景） |
| fix | prd-api | DocumentStoreController.ListInlineComments 三档权限：owner 总能读写；公开/有分享链 → 登录可读写、匿名可读；私有无分享 → 仅 owner |
