| fix | prd-api | 修复「把你的知识发布到智识殿堂」演示跑不起来:旧 seed 的 Step 1-3 selector 都是空间**详情页**的元素(`document-upload` / `document-store-publish`),但 actionUrl=`/document-store` 是**列表页**。用户跳转到列表页后找不到详情页的 upload 按钮,显示橙色失败卡片。<br>修复:改成 2 步,都用列表页稳定元素 `document-store-create`(新建空间按钮),Step 2 用文字指导"打开空间后怎么用";不再依赖无法预测的空间详情页 URL |
| feat | prd-admin | DocumentStorePage 列表页「+ 新建空间」按钮补 `data-tour-id="document-store-create"` 锚点 |
| feat | prd-admin | SpotlightOverlay 在「等待元素」的 6 秒内不再啥都不显示:右下角弹出**蓝色「正在定位第 X / N 步…」** 的胶囊 toast(带 Sparkles 旋转图标),rect 找到就自动消失切到真 spotlight,6s 超时则切到橙色失败卡片。避免用户点跳转后以为"没反应" |
