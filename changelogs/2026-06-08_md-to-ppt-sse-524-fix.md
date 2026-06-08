| fix | prd-api | 修复 MD转PPT SSE 两个引擎(MAP/CDS Agent)均 524 超时：SetSseHeaders 不再手动写 Transfer-Encoding: chunked(由 Kestrel 管理)，与既有 SSE 控制器一致 |
| fix | prd-api | MD转PPT SSE 末尾一次性吐出：补 IHttpResponseBodyFeature.DisableBuffering() 禁用 Kestrel 响应缓冲(与既有 SSE 控制器一致) + Cache-Control no-transform + 2KB padding |
| fix | cds | 修复 pnpm-workspace.yaml allowBuilds 占位字符串导致 master-run 启动崩溃：pnpm 11 把未批准的 native build(cpu-features/esbuild/ssh2)当 fatal(ERR_PNPM_IGNORED_BUILDS exit 1)→ exit 78 崩溃循环；改为 allowBuilds:true 显式批准 |
