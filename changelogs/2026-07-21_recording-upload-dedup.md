| fix | prd-api | 修复录音上传并发 /complete 竞态：完成前原子认领会话（Uploading→Completing），杜绝重复音频条目与文档数双计 |
| fix | prd-admin | 修复弱网下 /complete 响应丢失导致整文件重复上传：回退前回读会话状态并幂等重试 /complete，服务端已完成则复用同一条目 |
