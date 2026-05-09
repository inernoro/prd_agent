| fix | prd-api | 根治存储后缀错误：SaveAsync 新增可选 fileName/extensionHint 参数，优先用原始扩展名而非 mime 反推；3 套 storage 实现（Local/COS/R2）默认 fallback 从 .png 改 .bin |
| fix | prd-api | DocumentStoreController 上传时把 file.FileName 传给 SaveAsync，解决 .m4a 等被强存为 .png 导致 CDN 按图片处理 |
| fix | prd-admin | AudioWavePlayer 改用 MediaElement 模式（套 HTMLAudioElement），跨域音频不再走 fetch+CORS；onTimeUpdate 用 ref 隔离避免反复重建重复 fetch |
