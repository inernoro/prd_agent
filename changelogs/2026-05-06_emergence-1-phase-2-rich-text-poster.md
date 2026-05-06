| feat | prd-admin | 周报海报新增 ad-rich-text 版式（左侧 9:16 动态封面 + 右侧 hook 大字 + bullets，点 Play 切回全屏视频） |
| feat | prd-api | weekly-poster-publisher 胶囊 presentationMode 选项追加 ad-rich-text |
| docs | prd-api | WeeklyPosterAnnouncement.PresentationMode 注释同步实际支持的三种模式 |
| feat | prd-api | video-to-text 胶囊新增 asr 模式：下载视频 → ffmpeg 抽音 → 豆包流式 ASR → 可选 LLM 提炼 hook + bullets，输出兼容数组/单对象 |
| feat | prd-api | AppCallerRegistry 新增 video-agent.video-to-text::asr 入口供 ASR 模型池绑定 |
