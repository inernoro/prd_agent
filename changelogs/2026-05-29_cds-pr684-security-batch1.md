| fix | cds | [安全] operator console 的 run/ops/approve/reject/requests 加人类 cookie 鉴权,AI 与项目级 cdsp_ key 一律 403,封死"AI 自请求+自审批执行 root shell"+ confirmText token 泄露(Cursor High + Codex P1×2) |
| fix | cds | [安全] /api/cds-events SSE 对 project-scoped key 按 data.projectId 过滤,不再向某项目的 key 泄露全局 self.status 与跨项目 pending-import/config 事件(Codex P2) |
| fix | cds | pending-import.created 事件自带 pendingCount,消费方收到即可更新角标(Cursor Low) |
