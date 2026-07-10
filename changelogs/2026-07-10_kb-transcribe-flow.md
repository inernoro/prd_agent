| feat | prd-api | 知识库新增录音转录全链路任务（transcribe kind：ASR 转录 + AI 流式摘要，产物为「摘要 + 转录全文」新文档，POST entries/{id}/transcribe，与字幕生成共用 ASR 分发与排队去重） |
| feat | prd-admin | 知识库新增 Notion 式录音转录流程卡：上传音频 → 转录 → AI 摘要 → 保存笔记四阶段逐项点亮（SSE），摘要流式生长，完成后一键直达转录笔记；移动端为底部弹层、桌面端为右侧抽屉 |
| feat | prd-admin | 音/视频条目正文顶部新增「开始转录 / 查看转录笔记」常驻入口卡；工具栏与右键菜单新增「转录」；「添加」菜单新增「上传录音转笔记」 |
| chore | prd-admin | /document-store 登记为移动端 full 兼容等级 |
| feat | prd-admin | 知识库库内「新增」收敛为右下角调色盘 FAB 唯一入口（点击扇形展开：写文章/录音转笔记/上传文件/解析短视频/新建文件夹），下线侧栏小「+」菜单与顶栏「上传文档」按钮，消除重复与被遮挡入口 |
| test | prd-api | AppCaller golden 快照补入 document-store.transcribe-summary::chat（修 CI Server Build & Test 红灯） |
| fix | prd-api | 字幕生成/录音转录端点鉴权改为团队可写路径（与上传权限对称），修共享库协作者上传后无法转录的 404（Codex P2） |
