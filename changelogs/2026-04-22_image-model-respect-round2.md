| fix | prd-api | ModelResolver 尊重 expectedModel 的搜索范围扩大：候选池未命中时继续在同类型所有池 + LLMModels 直连里查找，避免"用户选的模型不在 AppCaller 绑定池"时被静默换成池默认项 |
| fix | prd-admin | 自适应模型（gpt-image-2-all 等）下 composer 两处尺寸 chip 改为静态展示，不再打开会暴露无关尺寸选项的 popover，消除"自适应但弹出 1:1/16:9 选项"的矛盾感 |
