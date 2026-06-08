| fix | prd-api | 修复 MD转PPT SSE 两个引擎(MAP/CDS Agent)均 524 超时：SetSseHeaders 不再手动写 Transfer-Encoding: chunked(由 Kestrel 管理)，与既有 SSE 控制器一致 |
