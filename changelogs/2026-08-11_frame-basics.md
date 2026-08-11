| feat | prd-admin | 点「AI 分层」先弹拆法输入（自动聚焦、回车即开拆），不再点完就闷头开拆 |
| feat | prd-admin | Cmd/Ctrl+G 编组、Cmd/Ctrl+Shift+G 解组、Cmd/Ctrl+A 全选，对齐 Figma 快捷键 |
| feat | prd-admin | Frame 头部可直接导出分层 PSD；多选浮条提供编组/解组/PSD/ZIP，不必先编组 |
| fix | prd-admin | 模型为凑层数补的纯黑/纯白实色层判成 solid 并默认隐藏（真实背景层不受影响，有回归用例守着） |
| chore | prd-admin | 画布元素新增 frameId（编组意图）与 layerGroupId（产物血缘）分离，旧数据读回时自动补 frameId |
| test | prd-admin | 补守卫：编组/解组接了键盘、Frame 与多选都能导 PSD、拆法气泡自动聚焦且意图真的传到调用上 |
| test | prd-agent | 冒烟扩到 34 条，覆盖拆法输入、全选、编组/解组、多选浮条 |
