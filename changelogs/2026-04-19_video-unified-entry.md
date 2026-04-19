| refactor | prd-admin | 视频 Agent 统一入口：撤掉「分镜模式 / 直出模式」两个 tab，合并为单一输入 Hero（UnifiedInputHero），根据用户输入（有附件 / 文本 > 200 字 → 拆分镜，短 prompt → 一镜直出）自动路由到对应管线 |
| refactor | prd-admin | 视频 Agent 输入字段默认收起：视频标题 / 系统提示词 / 画面风格 / 路由偏好 / 直出模型档 / 时长 / 宽高 / 分辨率 等统一折叠到「高级设置 ▸」，首次进入只暴露输入框 + 示例 chip + 上传按钮 |
| feat | prd-admin | 新增路由判定实时提示 chip（"即将：拆分镜 / 一镜直出"）+ 提交后 2.5 秒吐司显示判定原因，可在高级设置里强制"总是拆分镜 / 总是一镜直出" |
| feat | prd-admin | 新增历史任务抽屉（HistoryDrawer，createPortal 右侧）取代原左下历史列表，顶部应用条暴露「📂 历史(N)」按钮一键打开，带状态徽章 + 相对时间 |
| refactor | prd-admin | VideoGenDirectPanel 支持 `externalRunId` 纯输出模式：外层已创建的 videogen run 可直接传入，面板跳过内置输入区只做画布 + 进度 + 下载 |
| feat | prd-admin | 输入 Hero 支持拖拽文件（PDF/Word/Markdown/TXT 皆可），小文本文件（.md/.txt < 128KB）走 FileReader 可视，其它走 /api/v1/attachments 后端提取 |
