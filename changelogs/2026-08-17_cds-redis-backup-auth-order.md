| fix | cds | redis 备份连接段改成「先裸连、只有服务器真要求认证才找凭据」，修复线上全站 redis 备份因 env 连接串口令被当成 requirepass 而全部失败 |
| docs | cds | 记录 E34：扫进程命令行找 --requirepass 对默认配置的 redis 走不通（redis 会改写自己的 argv），真机量过并写明正解 |
