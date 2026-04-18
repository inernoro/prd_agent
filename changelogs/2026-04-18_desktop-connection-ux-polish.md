| fix | prd-desktop | 群组切换不再空白闪烁：messageStore 新增每群快照（LRU 12 群、每群 80 条），切回已访问群秒开，冷启动才等服务端同步
| fix | prd-desktop | 断线提示大重写：移除常驻"未连接"状态点，Header 红色脉冲 banner 改为 ≥4s 防抖的克制琥珀 pill，tauri 层 2s 防抖 markDisconnected 吃掉瞬时抖动，ChatContainer 初始态改 'connecting' 消除打开瞬间红点
| fix | prd-desktop | 群切换时清掉上一群的 SSE error 残留，避免 A 群错误贴到 B 群头部
| fix | prd-desktop | 连接自动探活改为指数退避 5s→60s（不再固定 5s 轮询），避免断网时持续占资源
