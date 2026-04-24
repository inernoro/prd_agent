| feat | prd-api | DailyTip 新增 `AutoAction` 字段(Scroll/Expand/Prefill/AutoClick/AutoClickDelayMs/Steps),默认 seed tips 全部填上真实 tour 动作:toolbox 预填「周报」、defect 自动点「提交缺陷」、report 多步 Tour、emergence 自动点「种下第一颗种子」 |
| feat | prd-admin | SpotlightOverlay 重写,按 AutoAction 依次执行:展开折叠面板 → 预填输入框(native setter + input event 触发 React onChange)→ 脉冲光圈 + 气泡卡片 → 多步 Tour「下一步」或延迟自动点击;用 createPortal 挂 body,支持 ESC/点击蒙版关闭 |
| feat | prd-admin | TipsDrawer / TipsRotator 通过新增的 `writeSpotlightPayload` 把完整 tip(title/body/ctaText/autoAction)写入 sessionStorage,SpotlightOverlay 读取后可在落地页渲染气泡卡片,旧的 selector-only 行为保留做向后兼容 |
| feat | prd-admin | 7 个目的页补齐 `data-tour-id` 锚点:marketplace-category-tabs / library-create / changelog-latest / toolbox-search / defect-create / report-template-picker / emergence-seed-input,让跳转后的高亮真的有地方落 |
| feat | prd-admin | DailyTipsEditor 表单新增「高级自动引导」分组,支持可视化编辑 AutoAction 的所有字段,含多步 Tour 的增删改,前端统一 `normalizeAutoAction` 规整空值 |
| refactor | prd-admin | 小技巧管理 PushDialog 扩到 `min(960px,100%)` 两栏布局(左推送表单 / 右投递列表),列表页加 `maxWidth: 1180` 改善宽屏留白;修复之前「跳转后除了打开页面一点作用都没有」的体验缺陷 |
