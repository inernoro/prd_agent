| fix | cds | 修复 GlobalUpdateBadge "立即更新" 触发后 30s 看不到反馈(Bugbot Medium):成功读到第一个非 error SSE 事件后立刻 setState({kind:'restarting'})+ fastPollUntilRef 拉满 90s,用户当场看到 spinner 不再怀疑"按了没用" |
| fix | cds | 修复 effective-env 排序与覆盖优先级反向(Bugbot Low):sourceOrder 之前 mirror=2 排在 cds-derived=3 前,但 cds-derived 实际覆盖 mirror。改 cds-derived=2, mirror=3,显示顺序与 winner-first 语义一致 |
| fix | cds | 修复 cds/web pnpm build 不再做类型检查(Bugbot Medium):Round 1 因 vite 渲染 OOM 删了 tsc -b,但同时也丢了类型守卫。改 build 为 "tsc --noEmit && vite build" — tsc --noEmit 内存比 tsc -b 低 3x,顺序执行不叠加 vite 内存压力 |
