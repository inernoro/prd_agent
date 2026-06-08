| fix | prd-api | 修复 MD转PPT SSE 两个引擎(MAP/CDS Agent)均 524 超时：SetSseHeaders 不再手动写 Transfer-Encoding: chunked(由 Kestrel 管理)，与既有 SSE 控制器一致 |
| fix | prd-api | MD转PPT SSE 流式不增量(末尾一次性吐出)：Cache-Control 加 no-transform 阻止 Cloudflare 压缩缓冲 + 开流写 2KB padding 击穿最小缓冲阈值 |
