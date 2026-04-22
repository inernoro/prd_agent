| fix | prd-admin | 在落地页同 URL 点 tip CTA 没反应:`navigate('/defect-agent')` 同路由 React Router 不 re-mount 导致 SpotlightOverlay 不重读 sessionStorage。`writeSpotlightPayload` 写完后广播 `spotlight-payload-updated` CustomEvent,SpotlightOverlay 监听后立即重读 + 重启 |
| fix | prd-admin | 多步 Tour 点「下一步」面板瞬间消失:旧逻辑会 `setRect(null)` 然后等 3s 找新 selector,modal 还没打开就超时。修复:点「下一步」时先帮用户 `click()` 当前 step 的可交互元素(按钮/链接),再前进;同时**保留旧 rect**,光圈停在原处直到新元素出现,无闪烁 |
| fix | prd-admin | SpotlightOverlay 选择器轮询上限从 3s 提到 8s(150ms × 50),覆盖大部分 modal / 面板异步打开场景 |
| refactor | prd-api | DailyTip seed 进一步精简到只保留 `defect-full-flow`(4 步全链路);删除 `report-agent`(1 步)和 `toolbox`(0 步,只 prefill),严格遵守用户规则「单步 tip 不需要教学」。其他多步演示由管理员通过 `/create-tour-demo` 技能按需生成 |
| feat | prd-api | AdminDailyTips 新增 `POST /api/admin/daily-tips/reset`:删除全部 DailyTip + 用 BuildDefaultTips 重新植入,用于 seed 规则迭代后一次性同步;返回 `deletedCount/insertedCount` |
| feat | prd-admin | DailyTipsEditor 工具栏新增「清空并重建」按钮(RotateCcw 图标),点击触发后端 `/reset`;前端 confirm 二次确认避免误操作 |
