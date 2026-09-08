| fix | cds | 分支卡片页脚重叠修复：构建期间进度改为页脚背景填充（方案 B），排队 / 无样本走斜纹等待，页脚只剩两列，sha chip 不再溢出叠在排队信息上 |
| polish | cds | 左侧导航：工具组（Agent / 缺陷 / 设置）沉回栏底贴账号（方案 S1），项距 2px 改 6px |
| test | cds | 新增分支卡页脚进度守卫，侧栏账号契约测试改为「工具组在 spacer 之后」 |
| feat | cds | 整站按 85% 呈现：根字号 85%，全部尺寸 px 转 rem（1–3px 细线保留），断点保持原始 px 不随尺度走，左栏两字标签保底 10px |
| test | cds | 新增 rem 棘轮守卫：index.css 与 tsx 出现 >3px 字面量即红 |
| rule | cds | 主题 token 规则补「尺寸单位 rem 唯一」一节 |
| feat | cds | 账号浮层新增「界面尺度」三档（紧凑 80 / 标准 85 / 宽松 100），全站唯一的大小杠杆，首帧前落地不闪 |
| polish | cds | 分支卡网格列数契约：列宽下限 20.5rem 随尺度走，五等分宽度算进下限、auto-fill 自然封顶五列（不走媒体查询） |
| fix | cds | React 数字型 style 长度改为 rem 字符串（错误浮层、报告树缩进、压测图表），守卫补数字型长度检查；RelationGraph / ReplicaSetPanel 按画布 px 单位整体保留 |
