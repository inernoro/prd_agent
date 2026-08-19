| fix | cds | mysql 恢复走裸管道读到的是 mysql 那一端的退出码，解压失败被吞成「已恢复」；改用与导出同一套 fd 退出码回传 + 前置 gunzip -t 完整性校验（E42） |
| fix | cds | mysql 恢复接收 0 字节上传时直接 400，不再一路走到「已恢复」 |
| feat | cds | mysql 恢复响应带上收到字节数与恢复前后表数，「已恢复」这句话带可核对的数字 |
| fix | cds | mysql 恢复收尾补 FLUSH PRIVILEGES，否则授权表写回去了、应用仍连不上 |
| fix | cds | 备份/恢复路由的七处报错改成截尾不截头，失败原因不再被切掉 |
| fix | cds | 恢复接口进函数先 req.pause()，避免上传 body 被 HTTP 日志中间件读光后落盘 0 字节（E43） |
| fix | cds | 缓存导入接口同样跨 await 才读 body，补 req.pause()；守卫扩到所有 req.pipe 调用点 |
