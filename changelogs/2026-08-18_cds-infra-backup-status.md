| docs | cds | 看板收尾 miduo-backen mysql（已补卷、已收窄、数据已回灌并独立验过）；新增 E44 离机失败连本地副本一起删、E45 cloudbridge-db root 口令不符 |
| fix | cds | mysqldump/恢复不再写死 -uroot：没有 root 口令时回落应用账号备它自己那个库（E45，修 cloudbridge-db 长期零备份） |
