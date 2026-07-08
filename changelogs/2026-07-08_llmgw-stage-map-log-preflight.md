| ops | scripts | LLM Gateway 生产 stage 增加显式 MAP 日志 preflight 豁免开关，避免 canary 阶段因缺 MAP Bearer 凭证卡死 |
| ops | scripts | LLM Gateway shadow 累计脚本增加 canary-intent-text 低成本取证预设，减少手工配置误差 |
| ops | scripts | LLM Gateway shadow 累计预设执行时强制指定 release commit，避免混用旧版本样本 |
| fix | scripts | 修复 report-agent shadow seed 未继承强制采样 key，确保 canary-intent-text 预设可稳定补齐目标样本 |
| test | prd-api | 增加 LLM Gateway shadow 累计预设守卫，防止 canary-intent-text 取证参数漂移 |
| test | prd-api | 增加 LLM Gateway 生产 stage preflight 豁免开关守卫，防止误删 release gate 说明与参数传递 |
| docs | doc | 记录 LLM Gateway 最新生产 shadow 证据期状态与下一步门禁 |
