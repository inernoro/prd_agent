| fix | cds | 分支卡片固定行高(min-h 158→244,按满卡骨架实测)消除卡与卡之间的空洞:短卡撑满、页脚落底,同行齐平 |
| polish | cds | 端口 chip 单行封顶(折叠阈值 8→3),超出收进「+N」悬浮浮层展开(只展开本卡、不推挤整行) |
| polish | cds | 浅色模式分支卡片提高对比:inset ring 更实边缘 + 轻投影把白卡从近白页面上抬起来(深色不变) |
| fix | cds | 修复端口「+N」浮层键盘/触摸不可达(Codex P2):点击=幂等打开不 toggle、onBlur 判 relatedTarget 容器内不关闭、拦截 keydown 冒泡防卡片导航抢占,Tab 可逐个聚焦端口 |
| fix | cds | 修复端口「+N」浮层鼠标不可达(Codex P2 悬停桥):浮层改 top-full + 透明 pt 覆盖 6px 间隙,鼠标从 +N 移到端口不再跨空隙触发 mouseleave 关闭 |
| fix | cds | 修复浅色卡片对比规则吞掉状态样式(Codex P2):Tailwind 无 @layer 全扁平,改用 :not() 排除 AI 活跃/选中/忙碌卡,状态阴影/光环照常可见;不再改 border-color,角色卡边框不受影响 |
