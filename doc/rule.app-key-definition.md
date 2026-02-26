# 应用 Key 定义规则（appKey / appname）

## 1. 目标
- 统一应用身份（appKey/appname）的命名与使用位置
- 保证 Controller 入口的身份隔离
- 保证与前端路由、/mds 接口、/api/mds 文档一致

---

## 2. 定义

### 2.1 appKey（应用身份）
**定义**：用于区分应用身份的唯一标识，Controller 层必须硬编码。

**关键原则**：
- appKey 不由前端传入
- 每个应用拥有独立 Controller 层入口
- appKey 使用 `kebab-case`

**已定义 appKey**：
- `prd-agent`
- `visual-agent`
- `literary-agent`
- `defect-agent`
- `report-agent`

---

## 3. 命名与唯一性

### 3.1 命名格式
```
{appname}  // kebab-case
```

### 3.2 唯一性约束
`appname` 必须在以下三处一致且唯一：
- 前端路由
- `/mds` 接口
- `/api/mds` 文档

示例：  
`/mds` 对应文档命名为 `mds-design.md`

---

## 4. 代码约束

### 4.1 Controller 强制硬编码
```csharp
[ApiController]
[Route("api/visual-agent")]
public class VisualAgentController : ControllerBase
{
    private const string AppKey = "visual-agent";
    // ...
}
```

### 4.2 禁止事项
- 禁止从前端传递 appKey
- 禁止在业务层动态拼接 appKey

---

## 5. 与下游概念的关系

appKey 是最上游身份定义，后续概念在此基础上衍生：
1) appKey/appname  
2) 应用子功能（Feature）  
3) 应用子功能调用大模型 key（appCallerCode）
