| feat | prd-admin | 视觉创作新增移动端线性生成器视图：手机进入编辑器默认对话式生成流（prompt 生成、放大预览、重新生成、以图改图、下载、参考图上传），与桌面画布共享同一 workspace，手机生成的图回填 PC 画布 |
| fix | prd-admin | 视觉创作画布补触屏手势地基：stage 加 touch-action:none 修复单指拖动被浏览器手势打断，新增双指捏合缩放 + 双指平移 |
| fix | prd-admin | 视觉创作列表页项目卡的重命名/共享/删除按钮移动端常驻显示，修复触屏无 hover 无法触达 |
| fix | prd-admin | 移动生成流时间线卡片补 shrink-0：修复卡片被 flex 压缩导致操作按钮被裁掉、列表无法滚动 |
| fix | prd-admin | 全屏视觉创作页移动端编辑器隐藏浮动返回钮与教程 pill，修复顶部控件叠压看不清 |
| fix | prd-admin | 补全全局 no-scrollbar 工具类，修复列表页场景标签横滚行滚动条外露 |
| fix | prd-admin | 移动生成流 SSE 断流后转 run 状态轮询兜底，弱网下生成结果不再卡在占位态 |
