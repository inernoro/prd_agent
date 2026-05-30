| feat | prd-api | 知识库新增模板约束（DocumentStore.TemplateKey）：验收报告库写入时校验必填 metadata（verdict/tier/target）与「需求一一对应表」section，机器归档缺项 422、人工软提醒 |
| feat | prd-api | 知识库跨环境同步：新增 GET /stores/{id}/export + POST /stores/import 端点，按 reportId 幂等去重 |
| feat | prd-admin | 知识库验收报告条目按 metadata.verdict 渲染通过/有条件/不通过状态徽章（新增 acceptanceVerdictRegistry 注册表） |
| fix | prd-admin | 验收报告库 owner 视角排序改为最新在前（created-desc）+ 默认显示更新时间，修复同名报告按字典序乱簇看不出新旧 |
| feat | create-visual-test-to-kb | 归档时建库带 templateKey、条目写 verdict/tier/target/reportId metadata；新增 kb_sync.py 跨环境同步脚本 |
