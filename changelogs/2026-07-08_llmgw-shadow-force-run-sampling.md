| ops | prd-api | LLM Gateway shadow 强制采样标记贯穿后台 run，覆盖生图、ASR、知识库字幕、视频与视频转文档证据采集 |
| ops | scripts | 收紧 LLM Gateway shadow seed 的图片和视频测试提示词，降低上游内容策略误伤 |
| test | prd-api | 增加后台 run 强制采样传播守卫，防止队列链路丢失 shadow 证据 |
