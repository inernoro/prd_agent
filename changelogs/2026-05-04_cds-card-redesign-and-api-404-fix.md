| fix | cds | **修复 /api/* 缺失端点返 HTML 让前端崩溃的根因** — `installSpaFallback` 的 legacy 兜底 `app.get('*')` 之前没有 skip /api/* 的守卫,任何不存在的 /api/... 路径会被 sendFile legacy index.html(200 + HTML),前端 apiRequest 解析失败但不报错,把 string 当对象用 → `data.bySource.project` 等访问崩溃。新加 skip-/api guard + `app.use('/api', json-404)` defense-in-depth,API 端点永远返 JSON,前端 apiRequest 能正确抛 ApiError(404) |
| fix | cds-web | VariablesPanel 增加响应 shape 校验 — 即使后端返回非预期格式(老版本 CDS / 中间代理改包),也给出明确错误「请先 self-update CDS 到最新分支」,而不是 property access 崩。同样守卫加到 MetricsPanel + 现有 bySource 渲染加 `?? 0` 兜底 |
| feat | cds-web | **分支卡片重设计(用户反复反馈的 3 个问题)**: |
| feat | cds-web | 1. 预览=重点色:running 态的 Eye 按钮去掉 `variant="secondary"`,走默认 primary 主橙色,真正"重点动作"。**完全删除卡片右下的 Play 部署按钮** — 部署有副作用,改走"打开抽屉 → 设置 tab → 重新部署",防止误点 |
| feat | cds-web | 2. 卡片大小一致 + 全部 tag inline:删除 `slice(0,1) + +N` 折叠逻辑,所有有 hostPort 的 service 全部显示,卡片 wrap 自动换行;status chip 改成 wrap 不 nowrap |
| feat | cds-web | 3. "未运行" 不再显示 chip,改成**整卡 opacity-60 暗示** — 用户视觉一眼能区分 running / idle,不需要额外 label;hover 时 opacity 恢复 100;异常和中间态(building/starting/...)保持正常亮度因为需要醒目 |
| test | cds | `tests/routes/server-integration.test.ts` 更新「OLD bug regression」用例 — 反映新的 JSON 404 行为(原本是 HTML 200),增加 `expect(parsed.error).toBe('not_found')` 断言 |
