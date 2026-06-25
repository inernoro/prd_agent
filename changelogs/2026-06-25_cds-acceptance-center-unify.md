| feat | cds | 验收报告新增 verdict/tier/缺陷计数/部署上下文(commit/branch/PR/deployMode)元数据,分支关联时自动补全部署上下文 |
| feat | cds | 验收报告列表支持 ?updatedSince= 增量过滤 + 响应附带 projectSlug,为跨系统(MAP)消费铺路 |
| feat | cds | cdscli report create 新增 --verdict/--tier/--branch/--commit/--pr/--deploy-mode/--defects 元数据参数 |
| refactor | cds | 验收技能 create-visual-test-to-kb 去分流:默认归档进 CDS 验收中心(按项目+文件夹,自包含 markdown 内联截图),不再分流到 MAP 知识库;local 离线兜底,doc-store 向后兼容 |
| feat | cds | 验收报告页新增 E2 验收看板(verdict 计数+通过率条)与逐行 verdict 徽章/部署上下文(commit/PR)展示 |
| feat | cds | 验收报告新增 E6 匿名只读分享链 /r/&lt;token&gt;(token 自鉴权、可撤销、不经登录网关),报告阅读器内一键生成/复制/撤销 |
