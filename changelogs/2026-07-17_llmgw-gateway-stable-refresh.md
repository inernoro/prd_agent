| fix | llmgw | 所有发布与回滚均保留 gateway 容器 IP，并同步活跃宿主配置后通过 nginx 原地 reload 刷新静态版本与上游解析，避免两级代理出现 502 |
| fix | deploy | 静态站改为离线校验后原子切换 current/previous，强制不可变产物 SHA256，并在发布失败时自动恢复上一版 |
| ops | deploy | 发布后与每六小时定时任务统一验证公网 HTML、实际 JS/CSS、精确提交和 LLM Gateway 双健康，保存不可覆盖 JSON 证据 |
| test | llmgw | 增加独立网关表面模式，验证 Gateway 页面资源、Console 与 Serving 精确提交，以及四协议无密钥统一拒绝；定时巡检同时覆盖生产独立入口 |
| fix | deploy | 恢复 `./exec_dep.sh release` 等价 latest 的兼容语义并补充可操作帮助信息 |
| test | prd-api | 增加 LLMGW 发布保留 gateway 容器与首次启动分支的合同测试 |
| test | deploy | 增加静态布局激活回滚、公网表面探针、发布证据不可覆盖和静态产物权限行为测试 |
| fix | llmgw | inproc 紧急回滚和保守 shadow 恢复只重启 API，随后原地校验并 reload gateway，禁止回滚路径再次制造代理 502 |
