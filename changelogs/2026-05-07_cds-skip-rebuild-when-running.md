| fix | cds | 修复访问预览域名总是触发"销毁并重建容器"的 bug：自动构建路径在 entry.status==='running' 且所有服务都在跑时跳过 docker rm -f && docker run，仅刷新 lastAccessedAt 后直接发 complete |
