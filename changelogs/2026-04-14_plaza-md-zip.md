| feat | prd-admin | 技能广场详情页 breadcrumb 新增「复制 MD」「下载 .zip」按钮，与「我的技能」详情页风格一致（小图标 + 切换反馈，1.8s 自动复位） |
| feat | prd-api | 新增 GET /api/skill-agent/skills/{skillKey}/export/zip 端点；GetSkillMd 放开已发布个人技能的非作者访问；内部拆出 ExportSkillAsZipAsync 共享 zip 打包逻辑 |
