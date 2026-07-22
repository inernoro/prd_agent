| fix | cds | 修复热重启等待页卡 35% 不动且就绪后不跳转:forwarder 将 /_cds/waiting-status 误按通用 passthrough 剥前缀打到 REST 端口,被 SPA 兜底以 200 HTML 吞掉,轮询 JSON 解析静默失败;现转给 master worker proxy 并保留 Host |
| fix | cds | 热重启进度改为 elapsed/median 连续映射 35+frac*61(服务端与等待页脚本同公式),弃用 max(35, frac*100) 下限钳制,消除重启前三分之一时间进度条完全静止的窗口 |
| test | cds | 新增 forwarder waiting-status 路由回归测试(不走 REST passthrough、保留 Host、未配 fallback 时退回旧行为)并更新热重启进度公式断言 |
| style | cds | 宝石六芒 loader 换代为「组装-碎裂叙事」核心动画:逐面弹入组装、驻留段轮流呼吸、逐面旋转碎裂循环,消灭旧版占一半周期的完整静止死相 |
| style | cds | favicon 从 ember 橙统一到品牌 iris 紫蓝(双栈同步),消除 favicon 与应用内品牌色系分裂 |
| feat | cds | 预览等待页、forwarder 等待页、nginx 自升级页前景加入宝石六芒核心叙事(服务端 SSOT 模块 loading-pages/gem.ts,矿色按状态设定 v2:构建琥珀/重启银河/品牌 iris),自升级页旧圆圈 spinner 退役 |
