| fix | prd-admin | 撒花从屏幕中心改为**从用户刚点的按钮位置**喷出:SpotlightOverlay「完成 🎉」按钮 onClick 读 `e.currentTarget.getBoundingClientRect()` 传给 `fireConfetti({ originX, originY })`,视觉位置跟用户操作一致 |
| feat | prd-api | seed 新增「大全套」演示 `showcase-all-features`(displayOrder=5,最靠前):跳 `/ai-toolbox` → autoAction.prefill 自动填「周报」→ 3 步 Tour(搜索框 → 首页搜索 → 命令面板 input),作为**回归测试锚点**,覆盖 scroll + prefill + 多步 + 最后撒花 4 大能力 |
| docs | .claude/skills | `createzzdemo` 触发词增加主推「**帮我创建一个小技巧 XX**」;工作流从 2 阶段扩为 **3 阶段**,新增「**阶段 3 立即演示**」章节,引导管理员入库后点 Play 按钮试播 + 最后一步点「完成 🎉」验证撒花从按钮喷出 |
