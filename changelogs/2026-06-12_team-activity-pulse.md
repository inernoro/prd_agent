| feat | prd-admin | 团队动态升级「团队脉搏」：新增顶部聚合面板（动作总量滚动数字 / 模块能量条 / 24h 活跃热力 / 成员排行），时间线按模块配色并折叠连续同类动作（×N 徽章） |
| feat | prd-admin | 团队动态新增隐私脱敏开关（默认开启）：动态标题与成员姓名打码，适合投屏与旁观场景，偏好本地记忆 |
| feat | prd-api | 团队动态新增聚合统计端点 GET /api/team-activity/stats（总量 / 环比上一窗 / 活跃成员 / 模块分布 / 成员排行 / 小时直方图），支撑脉搏面板 |
| polish | prd-admin | 团队脉搏产品化打磨：默认范围改「今天」、动作总量带环比趋势（较昨日/上周/上月）、模块图例与成员排行可点击下钻筛选、单模块时隐藏零信息量比例条 |
| style | prd-admin | 团队动态视觉对标业界（GitHub/GitLab/Linear）：时间线改 rail + 头像角标动作图标 + 吸顶日期头，活跃时段改平滑面积曲线，脉搏面板加分栏线与氛围光；标题恢复全文显示，匿名模式仅隐藏成员姓名 |
| style | prd-admin | 团队动态超宽屏排版修正：页面居中限宽 1240px 消除面板真空区与超长视线距离；视觉去「圆润饱满」——药丸统一小圆角、能量条/排行条细线化、撤掉径向柔光 |
| feat | prd-admin | 团队动态改控制台三栏布局：左栏成员统计（脉搏总量+环比+成员排行）、中栏时间线、右栏分类统计（模块分布/动作类型/活跃时段），两侧统计可点击下钻 |
| feat | prd-api | 团队动态 stats 端点新增动作类型分布聚合（Top 10，标签来自白名单注册表） |
| feat | prd-admin | 团队动态新增「行为洞察」视图：从沉默的行为信号聚合带证据的改进方向（频繁报错/等待过久/停留过久/秒退放弃/反复横跳），每条注明涉及人数、次数、位置与建议 |
| feat | prd-admin | 新增全局行为信号采集器 behaviorTracker：路由级可见停留与跳转批量上报，标签页隐藏不计时，登录后生效 |
| feat | prd-api | 新增 behavior_events 集合与 POST /api/behavior/events 批量采集端点；team-activity 新增 GET insights 聚合分析端点（API 日志 + 路由信号双数据源） |
| feat | prd-admin | 行为洞察处理闭环：洞察可「转为缺陷 / 确认待改 / 已修复 / 忽略」，忽略项指纹级持久化不再打扰，可一键恢复；转缺陷自动携带证据生成缺陷内容并关联展示 |
| feat | prd-api | 新增 behavior_insight_states 集合与 POST /api/team-activity/insights/state 端点；insights 查询按指纹挂载处理状态并默认过滤已忽略项 |
| style | prd-admin | 洞察面板视觉去 AI 感：单卡分隔行替代漂浮盒子、左缘信号色条、目标/指标走 mono 字体、琥珀色强调主操作；脉搏大数字改实色微光、排行条单色化 |
| feat | prd-admin | 行为洞察新增 AI 简报：一键流式生成面向产品负责人的洞察简报（SSE 打字效果 + 顶部模型可见），完成后可一键发布到知识库「行为洞察简报」存档 |
| feat | prd-api | 新增 GET /api/team-activity/insights/brief SSE 端点（ILlmGateway 流式 + LlmRequestContext + AppCallerRegistry 登记 insight-brief），洞察计算抽出 ComputeInsightsAsync 供查询与简报共用 |
| fix | prd-admin | AI 简报发布防重复：发布成功后按钮变「已发布」徽章，同日重复发布幂等更新同一篇文档而非新建；发布中禁用按钮 |
| fix | prd-api | AI 简报流式中断治理：SSE 每 10 秒心跳防代理空闲断连（写锁防交叉写入）、max_tokens 提至 8192、超时放宽 300s、done 事件带 complete 标记 |
| fix | prd-admin | AI 简报前端识别中断：未收到显式 done 即结束时提示「生成被中断」并提供重新生成，半截简报不允许发布 |
| fix | prd-admin | 评审修复（Bugbot）：环比零基线明示「全为新增」不再误标无动作；洞察视图明示「全部=近30天」口径；登出不再丢弃待传行为事件队列 |
| fix | prd-api | 评审修复（Codex）：AI 简报过滤已忽略洞察（与 insights 查询口径一致）；新增 team-activity.manage 写权限，洞察状态变更与只读查看权限分离 |
