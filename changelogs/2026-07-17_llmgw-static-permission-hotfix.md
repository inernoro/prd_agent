| fix | llmgw | 修复严格 umask 下原子静态发布目录不可被 Nginx worker 读取导致生产根页 500 的问题 |
| test | llmgw | 增加静态发布目录与文件权限归一化回归测试 |
| ci | llmgw | 增加生产发布脚本与真实 Nginx worker 的独立 CI 检查 |
| docs | llmgw | 记录严格 umask 生产故障、精确备份恢复与 PR #1176 防回归证据 |
