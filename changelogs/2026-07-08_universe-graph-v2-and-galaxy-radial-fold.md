| feat | prd-api | 自动补链 progress 事件携带 newLinks 明细(from/to/anchorText),供前端边生长动画增量绘制;标题撞名映射取最早创建(与 MentionService 同口径,含单测) |
| feat | prd-admin | 双链图页实体顶栏(返回/库名统计/搜索/生成双链/标题模式/库切换/星系,对齐知识星球顶栏),canvas 改容器尺寸+事件坐标修正 |
| perf | prd-admin | 双链图视口丝滑化:平移/缩放走目标值+帧率无关指数缓动,拖拽 1:1 跟手,滚轮锚点在 target 空间计算不漂移;渲染循环只挂一次(状态走 ref) |
| feat | prd-admin | 生成双链时边「一根根长出经脉」:SSE newLinks 增量加边(布局按 id diff 保坐标不重排),新边沿线段 0→1 亮色生长+头部光点+渐隐回常规色 |
| feat | prd-admin | 双链图节点标签默认显示正文标题(frontmatter title 派生,可切结构名),搜索/悬停卡双字段口径;deriveContentTitle 提取为共享 lib 与星系页共用 |
| feat | prd-admin | 双链图单击节点打开正文预览面板(ReaderPanel 从星系页提取共用,ESC 关闭/左缘拖宽/宽度偏好共享),双击进入文档改为自取命中节点 |
| feat | prd-admin | 星系折叠 2D 重做:放射状层级树布局(root 居中/层级同心环/分支按叶子数占扇区,环半径按节点数自适应),每颗星按深度错峰飞向 2D 目标位(折叠外层先动 1.5s 层层收拢),光路/引用弧/流光按两端进度双套曲线插值跟随,2D 态线路透明度/亮度/光点尺寸提升(变实变粗),相机取景距离按图盘半径自适应;替换第一轮 scale.z 压扁方案 |
