| fix | prd-admin | 任务台切换视图时左栏左右平移（三个视图内容列宽度不同 + 滚动条有无），改定宽双轨 + scrollbar-gutter |
| feat | prd-admin | 任务台备用队列支持拖拽排序，不再只能「提前」置顶 |
| feat | prd-admin | 任务台点行进去改标题、时间、备注（note 字段终于接上渲染） |
| feat | prd-admin | 任务台删除/放下可撤销，删掉的按原位置建回来 |
| feat | prd-admin | 我的任务页加可见性感知轮询，别人派活提建议会自己跟上 |
| feat | prd-admin | 任务台「粘一段话，AI 帮你拆」：流式吐候选任务，勾选后才入库 |
| feat | prd-admin | 任务台新增「建议」：任何人可提，提了不进对方队列，收件人自己吸取 |
| feat | prd-admin | 吸取建议可引用知识库（服务端记住上次选的）与补一句额外要求 |
| feat | prd-admin | 建议可拿去涌现派生，回写涌现树 Id 便于回溯 |
| feat | prd-api | 任务台新增拖拽排序 POST {id}/reorder，创建支持 orderKey 还原位置 |
| feat | prd-api | 任务台新增 AI 一键导入 SSE 端点，含日期对照表与逾期日期兜底 |
| feat | prd-api | 新增建议实体与收件箱/吸取/放下/涌现回写端点，吸取走 SSE |
| feat | prd-api | 开放接口与 MCP 新增 map_tasks_suggest（use 档即可提建议） |
| polish | prd-api | MCP 派活工具描述去掉「让他做什么」的支配语气 |
