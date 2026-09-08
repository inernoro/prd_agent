| fix | cds | 分支卡片页脚重叠修复：构建期间进度改为页脚背景填充（方案 B），排队 / 无样本走斜纹等待，页脚只剩两列，sha chip 不再溢出叠在排队信息上 |
| polish | cds | 左侧导航：工具组（Agent / 缺陷 / 设置）沉回栏底贴账号（方案 S1），项距 2px 改 6px |
| test | cds | 新增分支卡页脚进度守卫，侧栏账号契约测试改为「工具组在 spacer 之后」 |
| feat | cds | 整站按 85% 呈现：根字号 85%，全部尺寸 px 转 rem（1–3px 细线保留），媒体查询与 Tailwind 断点同步乘 0.85，左栏两字标签保底 10px |
| test | cds | 新增 rem 棘轮守卫：index.css 与 tsx 出现 >3px 字面量即红 |
| rule | cds | 主题 token 规则补「尺寸单位 rem 唯一」一节 |
