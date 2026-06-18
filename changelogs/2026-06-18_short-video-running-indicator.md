| feat | prd-admin | 知识库右上角「运行中的智能体」入口：短视频解析任务关掉抽屉/刷新页面后仍可见（sessionStorage 持久化 shortVideoRunStore），点击重开抽屉恢复进度；新增页面级 Host 对非终态 run 周期续查，刷新后自动继续推进不再凭空卡住/重新计时 |
| fix | prd-api | 视频下载器把任意 */octet-stream（含 binary/octet-stream）归一成 video/mp4（Bugbot），ASR 转写 chat-audio 路径排除所有 Exchange（gemini-native 等 transformer 会丢音频，doubao-asr 已单独分流，Codex P2） |
