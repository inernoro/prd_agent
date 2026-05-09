| fix | prd-api | doubao-asr 异步字幕生成路径走 JSON body (audio_data base64)，不再传空 multipart；DoubaoAsrTransformer 只读 standardBody，之前 100% 失败 |
| fix | prd-admin | DocumentStorePage 用 AnimatePresence 包裹字幕/再加工 Drawer，让 Wave 1 加的 motion exit 动画（spring 滑出 + backdrop 淡出）能正常播放 |
