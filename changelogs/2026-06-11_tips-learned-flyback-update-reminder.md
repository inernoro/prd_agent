| feat | prd-admin | 多步教程气泡新增「我已学会」一键退出口（标记学会该页不再自动弹），给觉得弹窗烦的用户无需走完整套即可退出 |
| feat | prd-admin | 教程关闭飞回入口动画扩展到所有关闭路径（X/点空白/ESC/我已学会/完成），并放慢一倍（720ms→1440ms）解决「看不见」 |
| feat | prd-admin | 新增「轻微提醒更新」(*-update-reminder) 第三类自动弹出：进页以单步悬浮气泡轻提醒新功能，看过即永不再弹 |
| feat | prd-api | 新增 visual-agent-paste-update-reminder seed（视觉创作首页可粘贴图片提醒），并把视觉创作 page-guide 第 4 步同步补充粘贴/拖入说明 |
| fix | prd-admin | 轻微提醒更新：同 session 内本页 page-guide 刚走完不再紧跟弹 reminder（避免重复打断），并占当天自动弹额度防抽屉在气泡上层展开 |
| fix | prd-admin | 单步教程 5s 自动淡出 / autoClick 完成的关闭也走飞回动画，与手动关闭口径一致 |
| fix | prd-admin | 轻微提醒更新只在精确目标页且锚点存在时才弹/标记学会，避免在编辑器子路由(/visual-agent/:id)弹空目标并永久消费 |
| fix | prd-admin | 视觉创作首页拖拽：移入内部子元素(textarea等)不再误清拖拽高亮，消除提示蒙层闪烁 |
| fix | prd-admin | markLearned 对非 page-guide 也记乐观学会版本，避免标记落库失败后陈旧刷新把 reminder 恢复成未学会、与 session 锁不一致 |
| fix | prd-admin | 轻微提醒更新去掉锚点 DOM 预检(懒加载页首跑锚点未挂会导致永不自动弹)，只保留精确路由门，锚点就绪交 SpotlightOverlay 轮询兜底 |
| fix | prd-admin | 抽屉自动展开的 reminder 抑制守卫加精确路由判断，避免子路由(/visual-agent/:id)上不会弹的 reminder 误抑制周更新抽屉 |
