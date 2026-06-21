| fix | cds | 验收报告 JSON 粘贴绕过全局 100kb 解析器，大报告(数 MB)可正常保存 |
| fix | cds | 本地账号 githubId 用唯一负数占位，避免多本地用户在 githubId 唯一索引撞键 |
| fix | cds | basic 模式登录放行 /api/auth/login 等路由，保住单用户部署登录回退 |
| fix | cds | 部署耗时仅在真正就绪(runtimeStartedAt)时采样，避免污染中位 ETA |
| fix | cds | mongo 用户操作痕迹按容量裁剪，避免无界增长 |
