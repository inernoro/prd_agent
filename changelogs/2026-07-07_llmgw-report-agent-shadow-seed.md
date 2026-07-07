| ops | scripts | 新增 LLM Gateway report-agent shadow 证据采集脚本，固化采样恢复、临时数据清理和证据统计 |
| ops | scripts | 扩展 LLM Gateway MAP shadow seed，新增 visual-agent 视频 raw 入口补证据能力 |
| ops | scripts | 新增 LLM Gateway 短时 shadow 采样窗口脚本，固化生产备份、100% 采样、seed 取证和强制恢复 |
| ops | scripts | 新增 LLM Gateway shadow 样本累计脚本，按 batch 复用短时采样窗口并自动输出 coverage 证据 |
| ops | scripts | 扩展 LLM Gateway MAP shadow seed，补齐 desktop chat、ModelLab、Arena 真实入口和 open-platform send 增长计数 |
| test | prd-api | 增加 LLM Gateway 采样窗口脚本守卫，防止恢复采样和密钥传参退化 |
| docs | doc | 记录 LLM Gateway 直连 ratchet baseline 清零证据，明确剩余发布阻塞转为运行态样本门 |
