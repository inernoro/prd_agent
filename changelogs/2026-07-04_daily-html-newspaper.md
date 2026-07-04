| feat | skill | 日报生成技能新增格式二选项：报纸版 HTML（米多智能体日报版式，默认，含头条版画插图 + 数据版图表配图纪律）与 md 朴素版并存；publish.py 支持 --report-html 并带自包含/禁脚本/viewport/禁 data:image 硬校验 |
| fix | prd-api | 知识库 HTML 条目摘要与搜索索引改为剥标签后的可读文本：修复正文保存/版本恢复后列表、卡片预览、搜索片段展示裸 HTML 标记的问题 |
| fix | prd-admin | 修复知识库 HTML 条目阅读滚动阻滞：srcDoc 沙箱 iframe 禁内部滚动杜绝滚轮 latch，量高加缓冲与防振荡阈值，并对外层滚动锚定免疫 |
| fix | prd-admin | serve 静态托管配置统一 SSOT 到 public/serve.json（cleanUrls 关闭 + 缓存头），nixpacks 启动命令改为自动发现 dist/serve.json，消除双部署路径配置不一致 |
| fix | skill | 日报发布脚本校验与发布前剥离 HTML 注释（防模板说明字样误触发校验与后端守卫），发布成功后回写剥标签可读摘要兜底旧版后端 |
