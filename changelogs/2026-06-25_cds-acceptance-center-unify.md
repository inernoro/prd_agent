| feat | cds | 验收报告新增 verdict/tier/缺陷计数/部署上下文(commit/branch/PR/deployMode)元数据,分支关联时自动补全部署上下文 |
| feat | cds | 验收报告列表支持 ?updatedSince= 增量过滤 + 响应附带 projectSlug,为跨系统(MAP)消费铺路 |
| feat | cds | cdscli report create 新增 --verdict/--tier/--branch/--commit/--pr/--deploy-mode/--defects 元数据参数 |
| refactor | cds | 验收技能 create-visual-test-to-kb 去分流:默认归档进 CDS 验收中心(按项目+文件夹,自包含 markdown 内联截图),不再分流到 MAP 知识库;local 离线兜底,doc-store 向后兼容 |
| feat | cds | 验收报告页新增 E2 验收看板(verdict 计数+通过率条)与逐行 verdict 徽章/部署上下文(commit/PR)展示 |
| feat | cds | 验收报告新增 E6 匿名只读分享链 /r/&lt;token&gt;(token 自鉴权、可撤销、不经登录网关),报告阅读器内一键生成/复制/撤销 |
| feat | cds | 验收报告新增 E4 验收回写 PR：把 verdict 作为 PR 评论 + GitHub check-run(验收绿/红) 推回关联 PR(报告须带 prNumber，项目已 link GitHub)，阅读器内一键回写 |
| feat | cds | 新增 WS3 MAP-KBTP v1 peer-sync 端点(handshake/ping/capabilities/signature/export/apply)，CDS 作只读源 peer 把验收报告以 document-store 资源暴露，HMAC-SHA256+5 分钟时间窗+一次性配对码鉴权，供 MAP 等系统整库 pull |
| feat | cds | cdscli 新增 peer pairing-code/nodes/revoke 配对管理命令(VERSION 0.7.1) |
| fix | cds | peer-sync HMAC 改用全局解析器已存的 req.rawBody 取原始正文(自带 body 解析器会被全局解析器抢先消费导致拿到空串、handshake 400)，测试镜像生产全局解析器 |
| fix | cds | peer-sync 空 body 的 HMAC bodyHash 改为 sha256("") 与 MAP PeerNodeService 对齐(原空串约定致 MAP 配对后 GET ping 401 回滚)；fail() 增嵌套 error.{code,message} 供 MAP 显示精确失败原因 |
| fix | cds | peer-sync 放行整个 /api/peer-sync/ 前缀(admin 除外)+ 显式 handshake/confirm·finalize 返 404、cancel 清半连接节点，使 CDS 单阶段握手被 MAP legacy-peer 判定(依赖 404)识别(原 confirm 落登录网关 401 致 MAP 取消配对) |
