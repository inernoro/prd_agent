| fix | prd-api | ASR chat-audio 路由收紧：IsChatAudioModel 不再用裸 gpt-4o 匹配（gpt-4o/gpt-4o-mini 不支持 input_audio），只认含 audio 或 gemini 的模型 |
| fix | prd-admin | 短视频卡片在解析失败/轮询超时（phase=error）时显示错误与详情，不再被卡片吞掉；状态行不再误显"忙碌中" |
