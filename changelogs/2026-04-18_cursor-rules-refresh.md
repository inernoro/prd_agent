| chore | .cursor/rules | 彻底刷新：以 .claude/rules/ 为唯一事实源，scripts/sync-cursor-rules.sh 自动生成 23 条 .mdc 镜像，修复 doc 路径失效/缺 LlmRequestContext/缺 Run-Worker/缺前端模态框/角色枚举陈旧等全部漂移 |
| docs | .claude/rules/llm-gateway.md | 新增「必须设置 LlmRequestContext」硬规则 + 判定清单 + pa-agent "User not found" 反面案例，把"质量门禁运行时 warning"升级为"规则层必看章节" |
