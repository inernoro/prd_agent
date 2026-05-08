| fix | cds | publisher 默认 fallback route 加 branchName 字段(原本只有 path-prefix routes 有,/ 路径 widget 不注入,Codex P2 + Cursor Bugbot High 同时报)|
| fix | cds | publisher unchanged-skip 改用真 JSON 内容比对(原 records.length:json.length 在 port 41000→41001 同 length 时误判 unchanged 不写盘,forwarder 保留 stale 路由,Codex P1 + Cursor Bugbot Medium 同时报)|
| test | cds | 新增 2 个回归测试覆盖 Codex/Bugbot 找到的 bug,1509 全绿 |
