| fix | prd-admin | 移动端首页/个人中心新增 VOC（行为洞察）入口，修复手机端完全找不到 VOC 的问题 |
| feat | prd-admin | 首页基础设施 SSOT（buildStaticInfra）补齐三处移动端孤儿入口：VOC、智识殿堂、开放平台（按权限门控） |
| fix | prd-admin | 补充 /team-activity 的移动端兼容标记（limited，横屏更佳） |
| feat | prd-admin | VOC 端点下钻改三段式：证据先行→大模型阅读效果→模型返回后收束成顶部 Tab（AI 报告为第一个默认 Tab，原始证据为第二个），治「AI 报告埋在长页底部要下滑」 |
| feat | prd-admin | VOC 下钻 AI 报告/请求样本包 ExpandablePanel：右上角放大全屏看 + 右下角拖拽改尺寸，解决窄抽屉大段内容看不全 |
| fix | prd-admin | VOC 下钻真实请求样本超长内容默认截断（>600 字），「展开全部」后限高滚动，避免撑爆抽屉 |
| polish | prd-admin | VOC 下钻抽屉桌面端加宽至 560px（手机仍 94vw），给根因诊断/报告更多默认空间 |
| feat | prd-admin | VOC 下钻根因诊断等待态改推进式步骤清单（读取样本→解析耗时→比对错误码→归纳根因），不再静态 spinner |
| fix | prd-admin | VOC 下钻根因报告改自适应全高展示，不再固定 460px 内截断（整页滚动交给抽屉） |
| feat | prd-admin | VOC 行为洞察仪表盘趋势爆点/声道看板新增全屏按钮（与热力图一致） |
| refactor | prd-admin | VOC 行为洞察移除「体验痛点指数」仪表盘（作用不大），右下整宽保留声道看板，删除 ExperienceStats |
