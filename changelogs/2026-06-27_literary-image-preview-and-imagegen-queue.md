| feat | prd-admin | 文学创作正文配图支持点击放大/缩小/拖拽预览（ImageLightbox 新增缩放控件，正文内联图片与右侧卡片统一接入灯箱） |
| fix | prd-api | 修复单个生图请求超时（最长 600s）会阻塞整个生图队列、导致后续所有生图跟着超时的问题：ImageGenRunWorker 改为有界并发处理 run（LLM:ImageGenMaxParallelRuns，默认 4），单个慢 run 不再饿死其它 run |
| fix | prd-admin | 文学创作配图灯箱：点击的图不在轮播列表时只展示用户实际点击的那张（不再误开第一张）；正文内联与右侧卡片两个入口统一 markerItemImageUrl 取 URL（trim 一致，跨入口可正确匹配下标） |
| fix | prd-admin | 配图灯箱评审修补：工具条/导航按钮 zIndex 高于图片（放大拖拽后不再被图片盖住拦截点击）；初始下标钳制到合法区间防破图；正文内联与右侧卡片统一规范轮播顺序（markers 阅读顺序）；正文链接图点击阻止冒泡，不再跟随链接跳走而是打开预览 |
