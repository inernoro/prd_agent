| fix | cds | [安全] operator console requireHuman 同时接受已验证 GitHub 会话(github auth 模式下原来 admin 被 403);GET /operator/requests/:id 改为「人类 OR 本请求发起方」校验,堵 shell stdout/args/logs 对任意认证调用方泄露;session callerKey 绑定真实凭据(Authorization Bearer + ai-access-key 别名 + GitHub session id)优先于 IP,防同 NAT 蹭 7 天 session(Codex P1/P2 + Cursor Medium) |
| fix | cds | [安全] compose 权威 escapeSeg/splitPath:service 名含点(api.v1)时不再被 split 误切,services.*.ports/networks 平台规则仍命中,堵权威绕过(Codex P2) |
| fix | cds | project-compose PUT 补 stateService.save() 持久化(原只改内存,崩溃丢失)(Cursor Medium) |
| fix | cds | pending-import approve + infra-resync update/add 路径补 restartPolicy 透传 + 存储边界 sanitizeDockerRestartPolicy(Cursor Medium/Low) |
| fix | cds | [项目设置] compose/storage/resync 的裸 fetch('/api/...') 改走 apiUrl(),生产托管 dashboard 下正确命中 CDS 控制面而非预览 app(Codex P2) |
