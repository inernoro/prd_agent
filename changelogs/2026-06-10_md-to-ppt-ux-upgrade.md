| feat | prd-admin | MD转PPT 新增所见即所得编辑模式：点击幻灯片文字直接修改内容，悬浮工具条 A+/A- 调整字号，postMessage 同步回主应用，退出时自动保存 |
| feat | prd-admin | MD转PPT 预览工具栏新增页码指示（N / M）、5 主题快速切换色点（即时换肤）、下载独立 HTML、全屏演示按钮 |
| feat | prd-admin | MD转PPT 空状态新增 3 个快速开始示例（产品发布会/季度业务汇报/技术方案评审），点击一键填入输入框 |
| fix | prd-admin | MD转PPT 修复翻页按钮在沙箱 iframe（opaque origin）下完全失效的问题，翻页改走 postMessage 通道 |
| fix | prd-admin | MD转PPT 修复发布/下载的 HTML 不携带前端注入主题样式导致主题丢失的问题；发布标题改为取自 deck title |
| fix | prd-admin | MD转PPT 下载文件名清洗非法字符，下载 anchor 挂载 DOM 后触发（Firefox 兼容） |
