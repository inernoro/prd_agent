| feat | prd-admin | 视觉创作生图等待态改版为「显影」：进度画在画框上，尺寸/阶段/剩余时间合并成底边一行 |
| refactor | prd-admin | GenSweepLoader 退场，换成 GenDevelopLoader；配色下沉到 tokens.css 的 --gen-wait-* 一族，组件内零硬编码颜色 |
| fix | prd-admin | 等待态占位卡不再由调用方画 border，消掉世界坐标边框与屏幕坐标描边错位 |
| test | prd-admin | 新增 GenDevelopLoader 单测（档位阶梯/阶段词/画框路径/动效声明纪律 31 项） |
| test | e2e | 生图等待态布局回归改盯新结构，并补「配色不跟主题翻面」与「fixture 必须注入 tokens.css」两条判据 |
| chore | prd-admin | 双皮肤棘轮台账移除 GenSweepLoader 条目（该文件已零硬编码，欠账减一） |
