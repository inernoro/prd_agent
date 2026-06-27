| feat | prd-admin | 文学创作正文配图支持点击放大/缩小/拖拽预览（ImageLightbox 新增缩放控件，正文内联图片与右侧卡片统一接入灯箱） |
| fix | prd-api | 修复单个生图请求超时（最长 600s）会阻塞整个生图队列、导致后续所有生图跟着超时的问题：ImageGenRunWorker 改为有界并发处理 run（LLM:ImageGenMaxParallelRuns，默认 4），单个慢 run 不再饿死其它 run |
| fix | prd-admin | 文学创作配图灯箱：点击的图不在轮播列表时只展示用户实际点击的那张（不再误开第一张）；正文内联与右侧卡片两个入口统一 markerItemImageUrl 取 URL（trim 一致，跨入口可正确匹配下标） |
| fix | prd-admin | 配图灯箱评审修补：工具条/导航按钮 zIndex 高于图片（放大拖拽后不再被图片盖住拦截点击）；初始下标钳制到合法区间防破图；正文内联与右侧卡片统一规范轮播顺序（markers 阅读顺序）；正文链接图点击阻止冒泡，不再跟随链接跳走而是打开预览 |
| fix | prd-admin | 正文内联配图点击改按 data-marker-idx（marker 身份）定位轮播起点，多 marker 共用同一 URL 时也不会命中错下标 |
| fix | prd-api | 生图并发后的"重生成冲突"取舍改为「最新成功优先、失败不抹旧图」：文学 marker 新增 ImageRunAt 时间戳（产图 run 的 CreatedAt），成功仅当更新才覆盖、失败在已有成功图时不写错误；marker 状态+资产指针+DoneImageCount 统一在一次乐观锁 RMW 内原子写入；画布元素同样按 imageRunAt 时间戳守成功排序（画布失败路径本就只动占位、不抹成功图），与完成顺序无关 |
| fix | prd-api | 配图灯箱并发取舍补存量兼容：ImageRunAt 字段出现前已成功的 marker（ImageRunAt 空但 Status=done 且有 AssetId/Url）失败回填时也判为"已有成功图"并跳过，避免一次失败重生成抹掉旧好图 |
| fix | prd-api | 配图资产指针写入改回"每 marker 原子 + 时间戳门控"（新增 AssetRunAtByMarkerIndex 门控字段）：批量并发时不再因 workspace 乐观锁被消息保存 churn 掉、重试耗尽而丢失 AssetIdByMarkerIndex/DoneImageCount；同时消除对可能为 null 的字典直接索引导致的崩溃 |
| fix | prd-admin | 图片灯箱开着时实时跟随最新配图：lightbox 只存打开位置（index+single 兜底），图片列表渲染时从最新 markerRunItems 重算（不再冻结快照）；ImageLightbox 越界下标改为渲染期 safeIdx 兜底，列表实时增减不再打断当前浏览位置 |
| fix | prd-api | marker 显示回填的成功/失败门控同时参考权威指针时间戳 AssetRunAtByMarkerIndex（非仅 marker.ImageRunAt）：新 run 指针写成功但 display RMW 失败时，旧/失败 run 不再把 display 改成与权威指针不一致的状态 |
| fix | prd-admin | 图片灯箱实时列表被重算成空时通知父级关闭，避免遮罩消失但父级 state 仍 open、Esc/清理失效 |
| fix | prd-api | 修复并发 run 整体回写 ArticleWorkflow 互相覆盖原子指针（High）：marker 显示字段改为针对该 marker 子字段的定向 $set（ArticleWorkflow.Markers.{i}.*），不再整体替换 wf，杜绝跨 marker 抹掉彼此的 AssetIdByMarkerIndex/AssetRunAtByMarkerIndex |
| fix | prd-api | DoneImageCount 改为单调门控写入（仅当新值更大才 $set，Lt 过滤）：并发完成时陈旧的较小计数不再最后落地把进度压低 |
| fix | prd-admin | 图片灯箱列表改回"打开时快照"（撤销实时重算）：避免打开期间更靠前 marker 后完成插入导致正在看的图悄悄错位（最小惊讶）；新配图重开灯箱即可见 |
| fix | prd-api | marker 显示写入加原子时间戳门控并恢复卡死态：done 写入 filter 携带 AssetRunAtByMarkerIndex 守卫（陈旧 run 通过内存门控后也不会后落地覆盖更新 run 的 display）；失败但已有成功图时把因重生成置 running 的 marker 恢复为 done（不再卡 running）；无成功图写 error 时 filter 守卫"无成功指针"防并发成功被覆盖 |
| fix | prd-admin | 图片灯箱滚轮缩放改用原生非 passive wheel 监听（React onWheel 默认 passive，preventDefault 被忽略导致页面在遮罩后滚动穿透） |
| fix | prd-api | 修复文学配图写入打到幽灵字段（P1）：ImageMasterWorkspace.ArticleWorkflow 等经 BsonClassMap 绑定为 camelCase，而 MongoDB 字符串路径 $set 不套用类映射约定——此前 PascalCase 字符串路径写到了顶层幽灵 ArticleWorkflow，编辑器/投稿读的 articleWorkflow 收不到 assetIdByMarkerIndex/doneImageCount/marker 状态。改为 camelCase 路径（articleWorkflow.markers.{i}.status 等），并给新字段 AssetRunAtByMarkerIndex/ImageRunAt 补 camelCase 元素名使读写一致 |
