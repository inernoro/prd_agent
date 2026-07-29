| fix | prd-admin | 修复知识库 HTML 正文里点击超链接导致整页卡死：父页拦截 iframe 内链接点击改用新标签打开（原先会在自增高 iframe 内导航整个 SPA，100vh 布局与自增高互相喂高触发 ResizeObserver 每帧循环），sandbox 不放宽且对存量旧正文同样生效；另给量高逻辑加失控熔断（1 秒内超 40 次写高即断开观察） |
| fix | skill | 周报采集器改用正式发布台账 /api/releases/runs 统计线上发布，并给出尝试/成功/失败/成功率四个数；分支预览部署版本拆成独立 previewDeploys 段，禁止再充当「线上发布次数」 |
| fix | skill | 周报采集器列日报补 all=true，修复日报被归进文件夹时被静默漏掉并误报「当天无日报」 |
| fix | skill | 周报采集器分享链过滤已过期 token，避免周报给出点开即 404 的日报深链 |
| rule | skill | 周报 html 硬约束新增：所有 a 标签必须带 target=_blank rel=noopener noreferrer；「线上发布」只认正式发布台账口径 |
| docs | doc | 订正 W30 周报的线上发布数据：由错误的「8 个不可变版本」改为正式发布 39 次尝试 / 成功 23 / 失败 16（成功率 59.0%，上周 35.1%） |
| fix | skill | 周报采集器解析项目 slug 为 CDS 规范 projectId（如 mdimp -> defd4695ab5f），避免 slug 与 id 不一致的项目被整体过滤成「0 次发布」的静默错误 |
| fix | skill | 周报采集器按 CDS 终态口径统计发布 run：成功率分母只含终态（success/failed/rollback_*），在途 run 单列 inFlight、回滚单列 rolledBack，消除「1 次尝试 / 0 成功 / 0 失败 / 0%」的自相矛盾 |
| fix | skill | 周报采集器读 CDS 正式发布台账时显式加载项目级 .cds/credentials.json，并把 cdscli die() 抛的 SystemExit 翻成普通异常 + 走 fatal_network_errors=False，避免只有项目级凭据时取不到数、或 CDS 不可达时整个采集器被带走 |
