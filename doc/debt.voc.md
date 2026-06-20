# debt.voc — 行为洞察 / VOC 体验之声 工程债务台账

> 状态：active｜归属：团队动态 - 行为洞察（`/team-activity?tab=insights`）
> 记录已知边界、待建造项、用户已确认但尚未落地的方向，避免跨 session 丢失。

## 待建造：顶部 ribbon 换成「我来时的路」流式动画（用户已确认方向，2026-06-20）

把顶部点不动的死步骤条（`ExperienceRibbon.tsx` 当前为静态六阶段）换成一段会演的「来路」动画。已出 demo（`behavior-insights-journey-mockup.html`）确认方向，用户追加硬约束：

- **播放时机**：切换时间范围（以及首次进入 / 重新聚合）时触发播放；播完落定为数据态。
- **真流式分析架构（关键）**：动画必须由**真实的流式分析**驱动，数据准确，不能是假特效。需要后端 SSE 端点（如 `GET /api/team-activity/insights/replay-stream?from=`），流式吐出真实管道进度与真实计数：监测(已采 N 条信号) → 预警(检出 M 处突增，附真实 burstPct) → AI 根因(待诊断 K 处) → 转缺陷/需求(已流转 X) → 修复追踪(在修 Y) → 复测回落(回落 Z%)。前端把动画进度同步到流事件，每阶段亮起时显示该阶段真实数字。
- **体量小巧**：不能太大，占 ribbon 一条带状区域即可，不喧宾夺主（artifact-is-experience：产物是主，动画是叙事配角）。
- **平滑落定**：播放完成后平滑过渡到「数据态 ribbon」（六阶段真实计数 + 可点入对应清单），不能突兀；主体页面结构保持不变（Hero/榜单/抽屉都不动）。
- **动态感**：要"真在干活"的感觉（粒子/光点沿路 + 计数跳动 + 突增曲线尖起再回落），但服务于真实数据，不为炫技。
- **降级**：流式不可用时退化为「直接显示数据态 ribbon」，不卡白屏（遵守禁止空白等待 + server-authority：CancellationToken.None + 10s 心跳）。
- **排期**：在 Wave B（多视角切换）之后做，避免与 ribbon/InsightsPanel 文件冲突；可与「时间选择新控件」合并为一个建造波次。

## 待定：时间选择控件替换（时光机 demo 被否，2026-06-20）

`behavior-insights-timemachine-mockup.html`（苹果 Time Machine 风格、全屏）被用户否：太 low + 全屏不宜查看。改为出**多个紧凑、锚定弹出、非全屏、数据感强**的替代 demo 供选型，确认后替换页头当前的 全部/今天/本周/本月 chips。候选见 `behavior-insights-timepicker-options.html`。

## 已落地（参考，勿重复）

- 体验全景热力图（treemap，全域/痛点双模式 + 写字入场 + 点睛 + 突增彗星 + morph + 全屏放大）
- 点痛点块下钻抽屉（错误码分布 + curl 样本 + AI 流式根因诊断）
- 闭环 ribbon（静态六阶段，待上面的流式动画替换）
- 痛点流转产品需求池（SourceSystem=voc-insight）+ 复测回落追踪（reboundPct）
- 布局 Hero 化 + tab/时间范围上移页头 + 切换 shimmer 过渡 + insights 视图不白拉 feed
- 多视角切换（趋势爆点/痛点雷达/站点地图/声道看板）—— Wave B 进行中
