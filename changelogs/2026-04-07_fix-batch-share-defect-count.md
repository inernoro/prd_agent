| fix | prd-admin | 修复一键分享缺陷时数量与列表不一致（前端传递可见缺陷 ID 列表） |
| fix | prd-api | 批量分享支持接收前端传入的 defectIds，确保分享内容与用户当前视图一致 |
| refactor | prd-admin | 分享管理用两个复制按钮替代一键分享+AI评分，直接导出用户原话+评论+VLM内容 |
| feat | prd-admin | 缺陷列表行显示缺陷编号(defectNo) |
| feat | prd-admin | 缺陷列表新增搜索框，支持按编号、标题、内容模糊搜索 |
| feat | prd-admin | 分享面板支持勾选缺陷+三种复制模式（含原图base64/含图链/含VLM描述），图片以 图1/图2 代称引用 |
| fix | prd-api | 新增缺陷附件代理端点，解决前端 base64 模式下跨域 CORS 失败 |
| fix | prd-admin | 复制内容补回 AI 工作流提示词（修复计划/评论API/标记完成 等阶段说明） |
