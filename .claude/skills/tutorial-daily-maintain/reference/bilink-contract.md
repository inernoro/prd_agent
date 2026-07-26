# 教程双链契约

## SSOT

| 文件 | 职责 |
|---|---|
| `llmgw/tutorial/manifest.json` | 教程 sourceId、源文件和书籍顺序 |
| `llmgw/tutorial/maintenance-map.json` | 页面、路由、变更源到教程步骤的正向关系 |
| `llmgw/tutorial/evidence-map.json` | 章节证据、验收提交和证据注册 |
| `llmgw/tutorial/maintenance.py` | 生成反向关系、验证不变量和输出报告 |

反向表由扫描器生成，禁止再手工维护第二份关系表。

## 关系粒度

每条成熟关系应包含：

```text
surfaceId -> route -> changeSource -> sourceId -> stepId -> evidenceId -> capturedAtCommit
```

迁移期允许只有 `surfaceId -> sourceId` 的粗粒度关系，但报告必须显示 `coarse-review-required`，不能显示“已同步”。

教程步骤使用不可见稳定标记：

```html
<!-- tutorial-step: stable-step-id -->
```

同一 sourceId 内每个标记必须恰好出现一次。

## 状态

| 状态 | 含义 |
|---|---|
| `skipped` | 没有命中相关变更，不生成草稿或报告 |
| `review_required` | 产品或教程有影响，需要按双链判断 |
| `synced` | 具体步骤和证据在目标提交验证通过 |
| `drift` | 页面、路由、步骤、证据或提交关系断裂 |

## 最低检测点

结构不变量每次全量执行，随机抽检只用于增加真实内容覆盖。随机种子使用 target SHA 并写入报告。

1. 页面、路由和 change source 存在。
2. sourceId 在 manifest 中存在。
3. 正向与反向关系集合对称。
4. step marker 唯一。
5. evidenceId 已注册。
6. capturedAtCommit 是目标提交祖先。
7. 共享主题变化命中所有视觉页面。
8. 无相关变更返回 skipped 且零草稿。

测试必须包含缺页面、缺步骤、缺证据、非法路由、孤儿教程和固定种子复现。
