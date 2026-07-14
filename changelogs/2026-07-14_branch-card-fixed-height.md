| fix | cds | 分支卡片固定行高(min-h 158→244,按满卡骨架实测)消除卡与卡之间的空洞:短卡撑满、页脚落底,同行齐平 |
| polish | cds | 端口 chip 单行封顶(折叠阈值 8→3),超出收进「+N」悬浮浮层展开(只展开本卡、不推挤整行) |
| polish | cds | 浅色模式分支卡片提高对比:更实的 hairline-strong 边框 + 轻投影,把白卡从近白页面上抬起来(深色不变) |
| fix | cds | 修复端口「+N」浮层键盘/触摸不可达(Codex P2):点击=幂等打开不 toggle、onBlur 判 relatedTarget 容器内不关闭、拦截 keydown 冒泡防卡片导航抢占,Tab 可逐个聚焦端口 |
