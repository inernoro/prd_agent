| fix | cds | [CDS 系统设置] 自更新历史改为常驻显示在「更新与重启」页面下方(不再藏在 Dialog 后面),并把"上次更新"chip 从可点击按钮改成纯标签(指向下方"完整历史见下方"),根治"按钮不够明显"和"看一眼被闪掉"两个问题 |
| fix | cds | 自更新历史列表不再随 SSE 每次 self.status 事件 re-render — 改用独立 `/api/self-update-history?limit=20` endpoint + 仅在"自更新真正完成"(updating: true→false)或用户点"刷新"按钮时才 fetch。中间的 heartbeat / status tick 全部忽略,杜绝看历史时被刷新闪掉 |
