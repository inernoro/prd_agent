| feat | prd-api | 网页托管上传幻灯片类 HTML 时注入翻页方向兼容垫片：只认左右方向键的 PPT 导出页也能用上下方向键/空格/PageUp-Down/滚轮/触摸滑动翻页（保守判定为幻灯片才接管，普通网页不碰） |
| fix | prd-api | 翻页兼容垫片重写为「可靠驱动优先」：新增 reveal/swiper/impress API + 任意带 next()/prev() 方法的自定义元素（如 deck-stage 这类 web component PPT）+ scroll-snap 直驱；仅在解析到可靠驱动时才接管并 preventDefault，无驱动时只对上下键尽力合成且不抑制原生，修复对忽略合成事件(isTrusted=false)的自定义 deck 上下键无效的问题 |
