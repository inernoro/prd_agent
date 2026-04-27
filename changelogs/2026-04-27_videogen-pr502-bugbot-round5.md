| fix | prd-admin | 视频 Agent 直出面板提交后不再重复 fetch + 双轮询：createVideoGenRunReal 成功后只调 onRunCreated 通知外层切换 selectedRunId，由 externalRunId useEffect 统一接管首次 fetch 与轮询，消除竞态 |
