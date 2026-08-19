| fix | cds | 手工下载对 mysql 走真正的 mysqldump（此前掉进 tar /data，回 200 却只有 22 字节空壳），导出失败不再伪装成功 |
| feat | cds | 新增 mysql 恢复入口：大 dump 走暂存文件 + docker cp，恢复前先存当前状态、存不下即中止 |
| fix | cds | 截断错误输出改为取尾不取头；redis stdin 守卫改成只管 redis 探测族，避免变成计数器 |
