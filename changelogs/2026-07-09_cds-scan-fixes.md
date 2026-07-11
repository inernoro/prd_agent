| perf | cds | 后端请求路径去同步阻塞：验收报告正文/截图资产 IO 全面异步化（含图片流式响应），JSON 存储 save 改 dirty+setImmediate 合并落盘（.bak 60s 节流 + flush + shutdown 兜底），技能导出改异步 tar |
| perf | cds | 容器日志黑匣子加 per-branch 双闸（10 条/2MB），启动裁剪存量并按 14 天窗口清理已删分支孤儿归档 |
| perf | cds | 前端时钟下沉：删除分支列表页顶层 1s 整树重渲染 tick，新增 useNowTick 组件级时钟；BranchCard 包 React.memo + latest-ref 稳定回调 + 派生数据 useMemo Map；分支/项目卡加 content-visibility 离屏跳过渲染；自更新页签 250ms tick 降 1s |
| feat | cds | 构建排队可视化：build-gate 排队状态挂上分支卡（「排队中 · 前面还有 N 个」chip），排队时间从耗时对比与 ETA 中位样本中剔除，排队中不再误报超预计 |
| fix | cds | 全局错误 Toast 双主题无背景（HSL 三元组未包 hsl() 致属性失效）；部署失败责任徽章白天对比度不足；报告 iframe 配色只跟 OS 不跟应用主题 |
| fix | cds | z-index 刻度收敛修真实遮挡：报告页移动端抽屉盖住 dropdown/重命名弹窗（11000/12000/10100 → 90/100/300），新栈刻度表写入 cds-theme-tokens 规则 |
| fix | cds | 发布中心引导深链 ?tab=remote-hosts 断头（设置页只认 #hash），改 #hash 规范写法并兼容 ?tab= fallback |
| fix | cds | 分支详情错误码 branch_not_found/missing_branch_id 裸展示改中文文案 + 返回/重试出路 |
| polish | cds | 发布中心项目选择改 /api/projects 下拉（未知 id 明示）；发布运行中 12s 静默轮询跟进终态并 toast；perf-health critical 告警前置为「运维」按钮红点 |
| docs | cds | 修正四处文档漂移：plan.cds.status 状态板自相矛盾、cds/CLAUDE.md 路由权威与规则路径、spec.cds 快照标注 + 项目管理域、债务台账点分重命名；cds-theme-tokens 规则 SSOT 更正为双栈两处并删 emoji |
