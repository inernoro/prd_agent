| fix | cds | self-update 进度状态从内存搬到磁盘(.cds/active-update.json),修复 actor=unknown / 卡 web-build 看不见日志 / 进程重启后状态消失三大幻觉 |
| test | cds | 新增 13 个 active-update-store 集成测试,实测跨进程读盘恢复 / stale pid 探测(用 spawnSync 取真死 pid)/ logTail ring buffer / 幂等保护 |
| chore | docs | CLAUDE.md §8.1 新增"自测优先"强制规则:AI 必须先穷尽集成测试 / cds-deploy / bridge / WebFetch 四条自测路径,禁止把校验责任先交还给用户 |
