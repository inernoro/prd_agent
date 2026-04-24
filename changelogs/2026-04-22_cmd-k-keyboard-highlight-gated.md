| fix | prd-admin | 命令面板鼠标离开卡片后"跳转"到最近项的视觉 bug：默认 selectedId 指向 flatList[0]（常是"最近使用"第一张），hover 清掉后 activeId 回落到它导致高亮瞬移。新增 keyboardEngaged flag，仅在用户真正按过方向键 / 有搜索词时才渲染键盘态高亮，否则无 hover 即完全无高亮 |
