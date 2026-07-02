| style | prd-admin | 新增界面重设计静态 Demo 画廊（/design-demos/）：登录后首页 4 版（极光操作台/纸上工作室/便当画布/静默驾驶舱）+ 未登录页 4 版（星云之门/墨与纸/引导序列/白昼流体）+ 索引页，全部自包含无外部依赖，供设计方向评审 |
| fix | prd-admin | 静态托管新增 public/serve.json 关闭 serve cleanUrls：修复 public 目录下额外 .html 页面被 301 去后缀后落入 SPA 兜底、永远不可直达的问题 |
