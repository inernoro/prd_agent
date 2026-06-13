| fix | cds | self-update 后仅在 forwarder 运行时文件变化时重启 forwarder |
| fix | cds | 修复 forwarder-run 覆盖运行时签名导致 master 重启时反复重启 forwarder 的问题 |
| fix | cds | 兼容旧版裸 forwarder 签名文件，升级时只迁移签名不重启业务转发进程 |
| fix | cds | forwarder 自同步签名仅纳入实际运行的 JS 文件，避免 source map 和类型声明变化触发重启 |
| fix | cds | forwarder 自同步优先按源码签名判断，避免构建产物波动导致 master 重启时误重启业务转发进程 |
