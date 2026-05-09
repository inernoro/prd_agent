| feat | cds | nginx 主模板用 `include cds-active-upstream.conf` 替代 inline upstream — 蓝绿 reload 切流的物理基础;首次启动 exec_cds.sh 自动创建该文件 |
| feat | cds | bootstrap 启动 ensure cds-active-upstream.conf 存在 + 写当前 active 端口 — 兜底 nginx 容器 mount 到不存在的文件路径 |
| feat | cds | 蓝绿失败 fallback 时流水带 blueGreenAttempted/Reason/Stage 字段;UI 历史区显示红色 "蓝绿失败 → 已回退" 副 chip + 维护页顶部红色告警横幅(近 1 小时内才显示) |
