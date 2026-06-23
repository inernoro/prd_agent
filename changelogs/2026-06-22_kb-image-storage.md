| feat | prd-api | 资产存储新增 local provider + auto 兜底：ASSETS_PROVIDER 未配且无云凭据时回退本地占位存储，修复无云凭据实例（如 CDS 预览）上传图片直接失败 |
| feat | prd-api | 知识库新增单独上传图片接口 POST /api/document-store/stores/{id}/images（multipart，返回稳定 URL），解决"上传 HTML 报告内嵌图存不住、又无单独传图入口" |
| fix | prd-admin | HTML 报告 srcDoc 注入 viewport + 流式 CSS，修复移动端验收报告显示过小（按设备宽度重排而非 980px 桌面视口缩放） |
| docs | chore | create-visual-test-to-kb / cds 两个 skill 补资产存储后端（local/R2/COS）+ 单独传图接口说明 |
