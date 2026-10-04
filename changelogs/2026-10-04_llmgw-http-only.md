| refactor | prd-api | 删除 LLM 网关模式开关（inproc / shadow / http）与进程内直连、影子比对装配，MAP 全部模型调用只经独立网关 |
| refactor | prd-api | 删除贯穿各业务 Run 的强制影子采样标记与采样请求头，移除影子比对数据模型与集合初始化 |
| refactor | llmgw | 删除 serving 与控制台的影子比对端点、控制台影子页面及只服务于切换的发布 gate，readyForHttpFull 更名 readyForRelease |
| ops | prd-api | compose 去掉模式开关与灰度白名单，CDS 预览与本地开发统一走网关；exec_dep.sh 不再需要 LLMGW_MODE，也不再经分阶段脚本；发布后从公网入口带 serve key 探测网关，拿不到 key 即拒绝发布 |
| chore | scripts | 删除分阶段发布脚本、发布台账、影子采样与回滚到 inproc 的脚本及对应工作流，验收种子脚本更名为 llmgw-map-acceptance-seed.py |
| docs | doc | 网关切换计划标为已完成，设计文档与债务台账同步，新增 serving 内部 legacy 配置兜底的还债条目 |
| chore | prd-api | quick.sh / quick.ps1 启动后端时一并在 localhost:5091 启动 LLM 网关 serving，并把本地 API 指过去 |
