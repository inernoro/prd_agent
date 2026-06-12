| fix | cds | CDS API 响应统一下发 `X-Cds-Cli-Latest`，让旧版 `cdscli` 普通请求也能提示运行 `cdscli update` 升级 |
| fix | cds-skill | CDS 技能 `SKILL.md` frontmatter 版本与 `cdscli.py VERSION` 对齐，并新增守卫测试防止两处版本再次漂移 |
| docs | cds-skill | drop-in 升级说明改为优先 `cdscli version && cdscli update`，手动重装仅作为旧包兜底 |
| docs | doc | 新增 CDS 技能版本与更新架构文档，沉淀版本权威源、响应头提醒、更新路径和 findmapskills 边界 |
| docs | skills | 同步本地 findmapskills 文档到 1.1.0，补充海鲜市场上传幂等覆盖与 slug/version 决策规则 |
