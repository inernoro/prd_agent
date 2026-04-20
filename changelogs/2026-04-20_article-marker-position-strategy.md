| feat | prd-admin | 文章配图标记新增"位置策略"选择器：自动 / 每大标题一张 / 每小标题一张 / 尊重用户锚点（文章内 `[IMG]` 占位符） |
| feat | prd-admin | 文章编辑阶段新增段落 gutter 加锚点 + 段落右键菜单「在上方/下方插入配图」 + 相邻锚点绿色边框视觉反馈 |
| feat | prd-admin | 首次进入文章配图编辑页时展示锚点教程气泡，每账户一次，点「知道啦」后永不再弹 |
| feat | prd-api | `LiteraryAgentPreferences` 新增 `AnchorTutorialSeen` 字段，记录配图锚点教程是否已看过 |
| feat | prd-admin | 位置策略切换到「尊重用户锚点」时若当前不在「预览」tab，自动跳过去便于打锚点；切到「每大/小标题」时 toast 引导 |
| feat | prd-admin | 「预览」页按策略展示同尺寸配图占位（1:1 dashed box），锚点和 per-h1/per-h2 策略都能看到"配图会落到这里"的直观反馈 |
| feat | prd-admin | 「尊重用户锚点」启用但还没打锚点时，预览页顶部出现脉冲引导横幅，明确告知如何打点 |
