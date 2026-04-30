| feat | prd-api | 海鲜市场上传 API 加幂等覆盖语义:`MarketplaceSkill` 加 Slug + Version 字段;Upload action 接受 form fields `slug`/`version`/`replaceMode`,默认 `auto` 模式按 (ownerUserId, slug) upsert,避免 AI 反复上传堆积重复条目。slug 兜底从 SKILL.md frontmatter `name:` 提取,version 兜底从 frontmatter `version:` 或自动 patch++ |
| feat | prd-api | OpenApi controller 加 `DELETE /api/open/marketplace/skills/:id`(仅作者),让 AI 上传错时能自助清理;响应字段 ToDto 暴露 slug/version |
| feat | prd-api | SkillZipMetadataExtractor 解析 SKILL.md frontmatter 的 name/version;ParseFrontmatter public 化便于单测;新增 8 个 xunit 测试覆盖正常/引号/缺字段/前导空行/大小写/空内容/畸形等边界 |
| docs | prd-api | findmapskills 模板 bump 1.0.0 → 1.1.0:上传段说明默认走幂等覆盖,加 AI 决策树("不要问用户用什么 slug / 下一版本号"),iconEmoji 示例去掉以符合根 §0 |
| chore | cds-skill | cds 技能去 emoji:SKILL.md / cli/cdscli.py / reference/{diagnose,maintainer,smoke,auth}.md 共 6 文件,符号化(✓→[OK]/✗→[FAIL]/⚠→[WARN]/📦→(zip),🪪🔧🤖🔑 删除);frontmatter 加 `version: 1.1.0`;新增"AI 决策规则"段落让 AI 用 cdscli scan 时不反复询问用户 |
