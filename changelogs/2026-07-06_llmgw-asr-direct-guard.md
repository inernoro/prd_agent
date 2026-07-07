| fix | prd-api | 禁止 MAP 生产路径直连豆包 WebSocket ASR，改为提示绑定 HTTP ASR/Whisper 以避免绕过 llmgw-serve |
| test | prd-api | 扩展 LLM Gateway 直连棘轮，阻止业务路径重新引用 DoubaoStreamAsrService |
