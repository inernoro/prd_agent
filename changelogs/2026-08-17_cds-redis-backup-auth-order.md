| fix | cds | redis 备份连接段改成「先裸连、只有服务器真要求认证才找凭据」，修复线上全站 redis 备份因 env 连接串口令被当成 requirepass 而全部失败 |
