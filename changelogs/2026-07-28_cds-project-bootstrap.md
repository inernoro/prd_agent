| feat | cds | 接入智能体新增「项目初始化」栏：选预设即得一条命令 + 一句话，真装技能而非只给提示词 |
| feat | cds | 新增匿名端点 /api/bootstrap/{preset} 生成引导脚本、/api/skills 代理 MAP 技能并缓存兜底 |
| feat | 技能 | 新增 phase0-guard：底座阶段护栏 + 面向老板与产品经理的六段式沟通规范、术语翻译、读者分层 |
| fix | cds | 技能缓存新鲜度补时钟偏斜守卫，避免文件时间在未来时缓存被永远判为新鲜 |
| test | cds | 新增 skill-proxy 与引导脚本守卫 13 项：缓存兜底、项目级安装、无密钥、注入转义 |
| docs | 文档 | 新增 design.cds.project-bootstrap 与 debt.cds.project-bootstrap |
