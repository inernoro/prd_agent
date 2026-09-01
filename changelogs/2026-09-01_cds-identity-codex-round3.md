| security | cds | 身份层签发接口交付的凭据明文不再落进 HTTP 日志：脱敏认 plaintext 字段，并按值形状兜底任何 cds 凭据串 |
| security | cds | cdscli identity save 的明文改走 stdin / 隐藏输入，不再进 argv 与 shell 历史；签发页同步教这条安全路径 |
| fix | cds | 凭据自检认「授权被撤」这一档，不再对着鉴权因授权撤销造成的 401 回答「有效」 |
| fix | cds | 预览地址判据改看「有没有可路由服务在跑」，只跑后台 worker 的分支不再被报成已部署 |
| fix | cds | 权限总览的凭据状态跟着实际能不能用走：主体被停用或授权被撤的凭据不再算进「有效凭证」 |
