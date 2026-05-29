# plan.cds-pr684-review-remediation

> 状态:进行中 | 负责:CDS agent | 创建:2026-05-29
> PR #684(分支 claude/elegant-einstein-8rWcJ)Cursor Bugbot + Codex 全部未解决 review 的清账计划。
> 原则(用户 2026-05-29 明确):CDS 是本 agent 统治下的产物,任何 CDS 代码 + CDS 服务器都必须能改、能修,不得以"这不是我写的 commit"推脱。

## 背景

PR #684 是一条积累了多个 commit 的大分支(operator console / 虚拟 compose / supervisor /
infra resync / 服务漂移徽标 等)。两个自动 review bot 持续提 issue。前几轮已修完
"本 agent 直接引入/相邻"的部分(restartPolicy 全链路 + compose 基线 + 白名单去重 +
注入防护 + 导出往返)。本计划清剩余的既有功能 review,不再区分"谁写的"。

## 批次清单

### 批 1 — 安全(最高优先)✅ 本批执行
- [x] operator-console `/run` `/approve` `/reject` `/ops` 加人类 cookie 鉴权
      (`req._cdsCookieAuth===true`),拒绝 AI/project key。封死"AI 自请求+自审批
      执行 root shell"+ confirmText token 泄露(A1/A2/A3,High+P1×2)
- [x] cds-events SSE 对 project-scoped key 过滤事件,不泄露跨项目/全局事件(F,P2)
- [x] pending-import created 事件去掉 dead `pendingCount` 变量(G,Low)

### 批 2 — compose 权限 flatten(P2×2)✅ 已完成
- [ ] project-compose diffChangedFieldPaths 覆盖顶层平台键(networks / x-cds-domain)
- [ ] 递归嵌套平台字段(services.*.deploy.replicas),防权限绕过(D1/D2)

### 批 3 — 前端/状态(P2×3)✅ 已完成
- [x] PendingImportInbox 审批前加载 composeYaml(别盲批)(E1)
- [x] useCdsEvents 订阅 operator.request.* 事件(审批弹窗实时)(E2)
- [x] self-status-cache 刷新合并补一次队列(防卡 updating)(E3)

### 批 4 — supervisor 迁移(P1×2 + P2×2)
- [ ] cds-supervisor.sh 启动子进程前 chdir 到 repo cds/ 目录(C3,P1)
- [ ] cds-supervisor.sh stop 超时杀子进程/进程组(C4,P2)
- [ ] operator-console self-update op:先起 supervisor 再停 cds-master(C1,P1)
- [ ] operator-console:supervisor 模式下阻止 self-update 回落 systemd(C2,P2)

### 批 5 — restart-drain(High)
- [ ] branches.ts + restart-drain.ts:180s→5s 超时回退评估。这是别人故意改的决策,
      需在"server-authority(客户端断开不取消任务)"与"5s 快速重启"间权衡。
      方案:默认拉回较长(如 120s)+ 保留 env 覆盖 + self-update 等真正需要快重启
      的路径单独短超时,而不是全局 5s。(B1)

## 自测要求(每批)
- backend tsc 0 错;触及 .cs 无;前端触及则 web tsc
- 新增/改动逻辑配 vitest
- push 后预览域名验收
