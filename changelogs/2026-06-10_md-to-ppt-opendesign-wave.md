| feat | prd-admin | MD转PPT 页位恢复：编辑保存/换主题/精修后 iframe 重载不再跳回第 1 页（ready 信号 + goto 回跳，借鉴 open-design） |
| feat | prd-admin | MD转PPT 圈选反馈：工具栏「圈选反馈」拖框圈选幻灯片区域 + 写要求，自动反查选区内元素文本组装成精修指令填入输入框（不自动发送） |
| feat | prd-admin | MD转PPT 编辑模式升级：悬浮工具条新增 6 色文字颜色、左中右对齐、撤销（最多 20 步）；序列化时清洗 reveal 运行时状态，产物更纯净 |
| feat | prd-admin | MD转PPT 工具栏模型 chip 可点击弹层切换（借鉴 open-design InlineModelSwitcher），免去翻设置面板 |
| feat | prd-admin | MD转PPT 生成完成后显示「下一步」引导条：精修建议 chip（填入输入框）+ 下载 HTML + 发布为网页 |
| fix | prd-admin | MD转PPT 页位恢复竞态修复：新 iframe 初始页码上报会清零实时跟踪 ref，改为重载触发时快照进 pendingRestoreRef，ready 按快照回跳 |
| fix | prd-admin | MD转PPT 编辑器样式写入改 setProperty important：修复主题覆盖层 !important 压住编辑颜色导致改色无效（验收 driver 实测捕获） |
