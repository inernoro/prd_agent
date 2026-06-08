| fix | prd-api | 修复 MD转PPT SSE 两个引擎(MAP/CDS Agent)均 524 超时：SetSseHeaders 不再手动写 Transfer-Encoding: chunked(由 Kestrel 管理)，与既有 SSE 控制器一致 |
| fix | prd-api | MD转PPT SSE 末尾一次性吐出：补 IHttpResponseBodyFeature.DisableBuffering() 禁用 Kestrel 响应缓冲(与既有 SSE 控制器一致) + Cache-Control no-transform + 2KB padding |
| fix | cds | 根治 #746 平台 self-update 崩溃：master-run 的 pnpm install 加 CI=true + --config.confirmModulesPurge=false，systemd 无 TTY 下 lockfile 漂移也能完成重装而非 abort(ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) |
