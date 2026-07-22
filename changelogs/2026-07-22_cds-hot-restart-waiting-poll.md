| fix | cds | 修复热重启等待页卡 35% 不动且就绪后不跳转:forwarder 将 /_cds/waiting-status 误按通用 passthrough 剥前缀打到 REST 端口,被 SPA 兜底以 200 HTML 吞掉,轮询 JSON 解析静默失败;现转给 master worker proxy 并保留 Host |
| fix | cds | 热重启进度改为 elapsed/median 连续映射 35+frac*61(服务端与等待页脚本同公式),弃用 max(35, frac*100) 下限钳制,消除重启前三分之一时间进度条完全静止的窗口 |
| test | cds | 新增 forwarder waiting-status 路由回归测试(不走 REST passthrough、保留 Host、未配 fallback 时退回旧行为)并更新热重启进度公式断言 |
