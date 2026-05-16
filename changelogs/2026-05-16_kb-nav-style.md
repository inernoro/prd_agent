| fix | prd-api | 知识库总访问量按行业做法去重：同一访客 30 分钟窗口内重复打开/刷新同一文档不再 +1，独立访客与总时长基于全量事件聚合 |
| fix | prd-admin | B9 知识库"发布到智识殿堂"按钮由灰色 surface-action 改为 surface-action-accent，明确可点击 |
| fix | prd-admin | B1 知识库文档浏览器去掉额外 px-5 双重内缩，卡片左右与上方 TabBar 边缘对齐，消除左上角空白竖条 |
| feat | prd-api | B4 划词评论支持"不选中也能评论"：SelectedText 为空时按全文评论接受，不再 400，不参与 rebind |
| feat | prd-admin | B4 评论抽屉无选区时也可输入并提交全文评论，卡片展示"全文评论"标签 |
| fix | prd-admin | B6 划词选区改以 selectionchange 为主信号 + dblclick 兜底 + 防抖，双击选行/拖拽选区稳定保留不再瞬间消失 |
