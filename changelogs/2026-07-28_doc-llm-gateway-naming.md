| docs | doc | LLM 网关 15 篇文档统一到 `platform.llm-gateway.*` 命名：`llm-gateway.*` 自创 appname 段与 `platform.llm-gateway-xxx` 连字符黏连两种历史写法全部收敛，同步改写全仓 143 处引用（`CHANGELOG.md` 按规则不动，残留 16 处旧名已登记 debt.platform.changelog-center 边界 8） |
| docs | doc | `rule.doc.naming.md` 补明网关归属：网关不是独立 appname，一律走 `platform.llm-gateway.*`，禁止 `llm-gateway.*` 与 `platform.llm-gateway-xxx`——此前规则的前缀示例与 canonical 清单自相矛盾 |
| docs | doc | `doc/index.yml` 与 `guide.list.directory.md` 按段重排，改名后的条目回到 platform 簇；两份索引条目与顺序逐行一致 |
| fix | doc | 验收规则 SSOT 回填：`rule.acceptance.map-enterprise.md` 的 daily_scope 调用示例补上多宿主技能根探测（此前只在三份技能快照里改过、权威原件没同步，导致 `check-acceptance-rule-ssot.py` 在 main 上常红），重跑快照同步与官方技能目录打包使三层内容重新对齐 |
