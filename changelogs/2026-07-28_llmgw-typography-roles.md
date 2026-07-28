| refactor | llmgw | 新增字号角色表 lib/typography.ts：系统规定「表格/表单/正文用 14px，控件与字段名 13px，12/11px 只留给角标」，Provider、模型、接入密钥、审计、影子对比、逻辑模型、提示词策略、组织、用量九个页面改为消费角色常量 |
| fix | llmgw | 修复配置类页面正文比请求记录页糊一档：表头 11px→14px、表格单元格 12px→14px、表单输入 12px→14px、字段名 11px→13px，行高与行距对齐请求记录页 |
| polish | llmgw | 页面表格统一挂 .lg-data-table：表头底色 + 行分隔 + hover 高亮，与请求记录页表格同款；请求记录页筛选抽屉控件由 12px/30px 提到 13px/36px，与其可见工具条同档 |
| chore | llmgw | 字体守卫增加角色维度：th/td/labelStyle/inputStyle 等再降到 caption/micro 档即 CI 失败 |
