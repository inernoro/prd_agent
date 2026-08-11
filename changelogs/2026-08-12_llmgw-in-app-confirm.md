| feat | llmgw | 新增站内确认弹窗（createPortal + ESC + 点蒙版 + 主题 token + 要求逐字输入才放行），替换全部 28 处原生 window.confirm/prompt |
| fix | llmgw | 破坏性操作的确认框不再依赖原生弹窗：自动化能覆盖、受主题控制、移动端不截断 |
| chore | llmgw | 文字预算守卫认识确认弹窗这个出口，弹窗文案不再被当成常驻正文误报 |
