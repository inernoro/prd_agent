| fix | prd-admin | EmergenceNode 修复"父节点不见了" — 上轮把 tail 滑窗换成全文导致每节点几千个 span + CSS 动画堆积, ReactFlow 重排扛不住把父节点挤飞。改回尾部窗口, 但 token key 用绝对 offset 防止滑窗闪烁 |
| feat | prd-admin | StreamingText 新增 maxTailChars prop — 通用尾部窗口能力, 内部 tokenize 走 offsetBase 让 React key 全局唯一 (滑窗时既不爆炸也不重复动画) |
| refactor | prd-admin | SseTypingBlock 内部预 slice 改用 maxTailChars 委托, 消除 substring 预切导致的 key 漂移 |
| test | prd-admin | 新增 5 个 StreamingText DOM 单测 (renderToStaticMarkup): 覆盖 maxTailChars cap / 省略符 / CJK / 短文本不裁切 |
