| feat | prd-api | 知识库正文写入新增图片资产规范化：支持 {{IMG:name}}+assets[] 一次性传输，自动把 data:image 迁移为正式资产图链 |
| refactor | create-visual-test-to-kb | 验收归档脚本改为知识库传输共享协议，一次提交报告正文与截图资产，由知识库后端统一上传图片和重写正文 |
| rule | skill | 更新 create-visual-test-to-kb 与 ai-defect-resolve，禁止绕过知识库写入边界手动上传图片或写入 data:image |
