| docs | doc | LLM 网关 15 篇文档统一到 `platform.llm-gateway.*` 命名：`llm-gateway.*` 自创 appname 段与 `platform.llm-gateway-xxx` 连字符黏连两种历史写法全部收敛，同步改写全仓 143 处引用（`CHANGELOG.md` 按规则不动，残留 16 处旧名已登记 debt.platform.changelog-center 边界 8） |
| docs | doc | `rule.doc.naming.md` 补明网关归属：网关不是独立 appname，一律走 `platform.llm-gateway.*`，禁止 `llm-gateway.*` 与 `platform.llm-gateway-xxx`——此前规则的前缀示例与 canonical 清单自相矛盾 |
| docs | doc | `doc/index.yml` 与 `guide.list.directory.md` 按段重排，改名后的条目回到 platform 簇；两份索引条目与顺序逐行一致 |
| fix | llmgw | 快捷提缺陷弹窗 16 处硬编码字号改为七档 token（10→micro / 12→caption / 13→secondary / 14→body）：该组件与字体守卫并行合入 main，守卫因此把 llmgw web 镜像构建打红 |
