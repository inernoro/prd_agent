| refactor | cds skills | 三个 CDS 技能按冷/热/核心三层重新定位：cds-project-scan (冷)、cds-deploy-pipeline (热)、cds (核心+分诊器)，触发词域无交集，按 Anthropic 官方最佳实践重写 description (third person + what+when + 反向排除) |
| refactor | cds skills | SKILL.md 总行数从 1755 行降到 498 行 (-71%)，cds-deploy-pipeline 从 930 行远超 500 行红线降到 175 行 |
| chore | cds-deploy-pipeline | 删除陈旧 495 行 cdscli.py stub，三技能共享 cds/cli/cdscli.py 单一物理拷贝 |
| docs | doc/ | 新增 rule.skill-trigger-disambiguation 锁定同族技能去重规则 (动词+方向词 / 反向排除 / slash 一一对应 / 歧义反问 / 物理去重) |
