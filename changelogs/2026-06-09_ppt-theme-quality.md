| feat | prd-admin | MD转PPT：前端注入主题 CSS 覆盖层，确保主题始终正确渲染（不依赖 LLM 输出） |
| feat | prd-admin | MD转PPT：注入 Google Fonts（Inter 400-900），提升排版质量 |
| feat | prd-admin | MD转PPT：显示模型徽章（模型名 + 平台）在 artifact 工具栏 |
| feat | prd-api | MD转PPT：扩充 CSS 组件库（.feat 功能列表 / .table 对比表 / .step-row 流程 / .callout 标注） |
| feat | prd-api | MD转PPT：5 种主题增加风格个性描述，版式库扩展至 10 种，质量自检覆盖视觉多样性 |
| feat | prd-admin | MD转PPT：借鉴 open-design 重设计 5 种差异化主题（Tech 极黑/钴蓝格纸/纸墨编辑/复古 Zine/Swiss 极简），各主题 !important 覆盖 reveal.js 元素级样式 |
| feat | prd-admin | MD转PPT：钴蓝格纸主题注入 CSS 方格纸背景，Swiss 极简主题添加页眉页脚发丝线，Tech 极黑主题添加渐变光晕 |
| feat | prd-admin | MD转PPT：扩充字体栈（JetBrains Mono / Newsreader / Hanken Grotesk / Playfair Display / Space Grotesk / Noto Serif SC），各主题字形各异 |
| feat | prd-api | MD转PPT：更新后端 ThemeTokens 5 个新主题描述，提示词强化字体/背景/层叠约定 |
| fix | prd-admin | MD转PPT：修复刷新后历史记录丢失问题——改用 lazy useState initializer 在首次渲染前从 sessionStorage 恢复状态，消除 saveSession 以空初始 state 覆写的竞态 |
