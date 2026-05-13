| fix | prd-admin | EmergenceNode 修复"填满又清空"闪烁 — 丢弃 tail 滑窗, 直接喂全文 liveText (offset key 才稳定) |
| fix | prd-admin | SkillAgentPage 创建技能对话气泡 (msg.content) + 自动试跑 (autoTestResult) 补齐 StreamingText 接入 (之前只改了 testResult) |
| feat | prd-admin | StreamingText 新增 cursorContent prop ('bar' \| 'dot' \| ReactNode), 支持业务自定义 cursor |
| feat | prd-admin | 新增 <MapCursor /> 品牌 cursor 组件 (M 字母 + 发光, 与首页 MAP loader 同源) |
| feat | prd-admin | Literary 创作 rawMarkerOutput cursor 切换为 <MapCursor size={12} /> 作为定制示例 |
| docs | doc | rule.streaming-text.md 补充 cursor 定制使用方式 |
