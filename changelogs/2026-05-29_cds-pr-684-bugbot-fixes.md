| security | cds | **High 级修复 (Cursor Bugbot)**:运维操作 session 授权范围加 argsHash 绑定。原 sessionKey 只含 (callerKey, opId),用户对一条 `shell.run dmesg|head` 点"授权 7 天"= AI 之后 7 天可跑任意 root 命令。改后 sessionKey = `${caller}::${opId}::${sha256(args).slice(0,16)}`,不同 args 必须重新审批。7 天 TTL 保留(用户明确要求) |
| security | cds | **Medium 修复**:`POST /api/cds-system/operator/run` 400 响应不再回显期望的 confirmText 字段。原行为允许调用方一次往返拿到 token 立刻重发,绕过二次确认。改后只返通用 hint 文案 |
| docs | cds | 更新 `operator-approval.ts` 顶部注释:1h → 7 天 + 说明 argsHash 绑定原理 |
| fix | cds | **Medium 修复**:`container.startInfraService` 数组形态的 entrypoint 余下元素不再被静默丢失。`entrypoint: ["python3","-m","http.server"]` 现在正确生成 `--entrypoint python3 ... image -m http.server` |
| refactor | cds | [CDS 系统设置] 删除"运维控制台" Tab(`OperatorConsoleTab.tsx` + tabGroups 注册)。与弹窗审批流(`OperatorApprovalModal`)100% 功能重叠且暴露面更大;后端 op 注册表 + 路由全部保留,弹窗审批继续使用 |
| feat | cds | [项目设置 → 基础设施 Tab] 顶部增加「全部启动」/「全部停止」按钮 + 数据卷保留说明,改善 openvisual minio 灾难暴露的"逐个点删除" UX 问题 |
| test | cds | 新增 `operator-approval-args-binding.test.ts` 7 个测试,锁定 session args 绑定行为(避免未来回归到"7 天任意命令") |
