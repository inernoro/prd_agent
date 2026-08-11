| fix | prd-admin | 解组后刷新 Frame 会复活：读回时无条件拿 layerGroupId 补 frameId，把「解组」静默撤销；改为按迁移标记区分「旧数据」与「真的解过组」 |
| refactor | prd-admin | 画布落盘时序抽成 canvasSaveSchedule 纯函数，「撞频控改期而非丢弃」从此可单测 |
| chore | prd-admin | 画布元素补 data-frame-id 结构标记，供冒烟判编组存活 |
| test | prd-admin | 新增落盘时序单测与编组持久化回归（含旧数据兼容），均做红绿闭环 |
| test | prd-agent | 冒烟扩到 43 条：多选 PSD 反读、多选 ZIP 条目数、编组/解组刷新存活、浅色主题对比度 |
| docs | prd-agent | 验收债务台账更新：8 条中 5 条转「已守」，剩 3 条明确为「等外部输入」或「刻意不做」 |
