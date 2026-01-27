## 文档命名规则（doc/）

### 适用范围
- `doc/` 目录下除 1~5 号核心文档外的所有文档

### 命名规则（类型前缀）
1) **Agent 设计类文档**  
   - 命名：`agent.{agent-name}.md`  
   - 示例：`agent.visual-agent.md`

2) **基础设施/设计类文档**  
   - 命名：`design.{appname}.md`  
   - 示例：`design.model-pool.md`

3) **原则/规范类文档**  
   - 命名：`rule.{topic}.md`  
   - 示例：`rule.app-feature-definition.md`

### appname 唯一性约束
`appname` 需要在以下三处保持一致且唯一：
- 前端路由
- `/mds` 接口
- `/api/mds` 文档

示例：  
`/mds` 对应文档命名为 `design.mds.md`

### 权限规则补充
权限相关文档包含四个 key 的合并逻辑（四 key 合并），应在命名与内容中明确体现。
