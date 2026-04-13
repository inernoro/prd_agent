| feat | cds | 拓扑视图大修：向 Railway 对齐（rich cards + pan/zoom + toolbar + click-focus edge highlight） |
| feat | cds | 列表/拓扑 toggle 移到 header 右上角（靠近主题/设置按钮），符合用户反馈 |
| feat | cds | 节点卡片翻倍信息密度 236×110：服务图标 + 名称 + 状态点(运行中/构建中/错误/待命 彩色) + 镜像缩写 + 端口 + 依赖数 + 🌿 自定义 pill |
| feat | cds | 根据镜像名/服务 ID 自动选图标：mongo→🍃 / redis→🔺 / postgres→🐘 / node→🟢 / dotnet→🟣 / python→🐍 / rust→🦀 等 |
| feat | cds | 画布背景改为 grid-dot radial-gradient（`background-size: 22px 22px`），替代旧的 dashed border，观感接近 Railway |
| feat | cds | Pan/zoom：鼠标滚轮以光标为中心缩放 (0.3x–2.5x)，拖拽平移，cursor 状态联动 grab/grabbing |
| feat | cds | 底部左下工具条：放大 / 缩小 / ⊡ 自适应缩放 / ◉ 1:1 复位 + 右上角缩放百分比指示器 |
| feat | cds | 单击节点 → 聚焦（高亮所有相连的边 + 其他节点灰显）；双击节点 → 打开容器配置 modal 并定位到对应 profile tab |
| feat | cds | 从 `branch.services[profileId].status` 读实时状态，驱动节点状态点着色（running=绿 / building=琥珀 / error=红 / idle/stopped=灰） |
| feat | cds | 依赖连线改为虚线 + 箭头 + 聚焦时高亮绿色实线；无依赖的服务不再孤立显示为问题，而是明确表达"独立服务" |
| refactor | cds | 节点尺寸常量抽成 `TOPO_NODE_W/H/GAP_X/Y/PAD`，后续调优无需改多处 |
