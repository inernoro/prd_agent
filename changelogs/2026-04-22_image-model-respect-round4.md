| fix | prd-api | 撤回 round3 的"跳过 scheduler"短路。零信任原则下 scheduler 是防御验证层不能省略。真正根因修在匹配本身——picker 发送 pool Code 作 modelId（如 "gpt-image-1-5" 带横线），旧匹配在"池所有模型被标 Unavailable"时整池跳过→回落到第一个池；另外 "gpt-image-1-5" vs "gpt-image-1.5" 命名差异也需兜底 |
| feat | prd-api | FindPreferredModel 增强：新增 Tier4 归一化匹配（去点/横线/下划线后比较），同档位池命中时不再因"模型 Unavailable"整池跳过（尊重"能选就代表能用"原则，真实请求失败时再让上游降级）；每档写详细 info/warn 日志便于未来定位命名不一致问题 |
