| chore | doc | 每日熵减计划：D1-D5 全部干净（doc/ 命名、index.yml、guide.list、CLAUDE.md 技能表均无缺项/幽灵项；D4 的 `**pnpm**` 复核为正文加粗提及非技能表行，0 改动），D6 处理 5 条 changelog（开放平台授权表主题对比度修复/CDS 复制集双画布批次/知识库实时转写/CDS 分层冒烟内容契约/llmgw 移动端相关教程入口），其中实时转写批次补充 `doc/debt.knowledge-base.md` 新章节，复制集批次已由 `doc/design.cds.replica-set.md` + `doc/debt.cds.md` 全量覆盖，其余 3 条为窄范围 UI/bug fix 无对应设计文档，仅登记 manifest，manifest 累计 492 条 |
| fix | scripts | 围栏判定认行首缩进（四格起是缩进代码块），index.yml 成员只认 docs: 段 |
| fix | scripts | 技能 frontmatter 先判 YAML 语法（修好 9 个真坏的 SKILL.md），已结清区的活账判定扩到标题/行状态/残留尾巴三种形状 |
| fix | scripts | 证据脚本的进度页写入目标改回生成物路径（曾指向权威设计文档且是整份覆盖写），并加守卫防复发 |
| fix | scripts | 缩进代码块里的假导读不算数、引用块里的围栏照样识别、shell 块划出命令与脚本界线 |
| fix | scripts | 未闭合 shell 围栏文末结算、列表项里的围栏照样识别、引号标量转义按 YAML 规则校验 |
| fix | scripts | 散落源码引用补上仓库根的入口文件，正文扫描跳过顶层缩进代码块（列表续行不误伤） |
| fix | scripts | 头部元信息按标签白名单认（正文标签不再冒充元信息），台账欠账清单更正为 23 周报 + 9 篇活账 |
| fix | scripts | 带行号的源码路径不重复计数，--fix-links 跳过范围与检测端对齐 |
| fix | scripts | 面包屑扫描按 NUL 读跟踪文件（中文名不再被静默跳过），技能 frontmatter 每个键都查 YAML 语法 |
| fix | scripts | 缩进代码块判据认制表符，流式集合括号按同类配对判 |
| fix | doc | 修一处嵌套坏链并加全库零容忍守卫 |
| fix | scripts | 死链闸挖掉行内代码再找链接，列表续行里的围栏按相对缩进判 |
| fix | scripts | 技能/规则根下的 md 计入散落引用，改写端补列表上下文，已结清区认「偿还中」 |
| fix | scripts | 已结清区认 blocked 等状态，引号标量收尾后不许跟多余内容 |
| fix | scripts | 已结清区状态改为反判（只认结清词），frontmatter 无冒号行判红 |
