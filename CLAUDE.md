# 项目架构规则

## 应用身份隔离原则

**核心原则**：每个应用必须有独立的 Controller 层，即使底层功能相同，也要在 Controller 层面区分身份。

### 规则说明

1. **Controller 层身份隔离**
   - 每个应用（如文学创作、视觉创作）必须有自己的 Controller
   - Controller 中硬编码该应用的 `appKey`，不由前端传递
   - 即使多个应用调用相同的底层服务，也要通过不同 Controller 入口

2. **appKey 命名规范**
   - 使用 `snake_case` 格式
   - 命名要清晰表达应用用途

3. **已定义的应用标识**

   | 应用名称 | appKey | 说明 |
   |---------|--------|------|
   | 文学创作 Agent | `literary_agent` | 文章配图、文学创作场景 |
   | 视觉创作 Agent | `visual_agent` | 高级视觉创作工作区 |
   | PRD Agent | `prd_agent` | PRD 智能解读与问答 |

4. **为什么这样设计**
   - 权限控制：未来可以基于 Controller 做细粒度权限管理
   - 功能隔离：不同应用的特性（如水印配置）互不影响
   - 可维护性：每个应用的入口清晰，便于追踪和调试
   - 扩展性：新增应用只需添加新 Controller，不影响现有逻辑

### 示例

```csharp
// 正确做法：在 Controller 中硬编码 appKey
[ApiController]
[Route("api/v1/admin/visual-agent")]
public class VisualAgentController : ControllerBase
{
    private const string AppKey = "visual_agent";

    [HttpPost("image-gen/runs")]
    public async Task<IActionResult> CreateImageGenRun(...)
    {
        // 使用硬编码的 AppKey 调用服务
        await _imageService.GenerateAsync(..., appKey: AppKey, ...);
    }
}
```

```csharp
// 错误做法：由前端传递 appKey
[HttpPost("image-gen/runs")]
public async Task<IActionResult> CreateImageGenRun([FromBody] Request request)
{
    // 不要这样做！
    await _imageService.GenerateAsync(..., appKey: request.AppKey, ...);
}
```

## 水印配置

水印配置基于 `appKey` 绑定，只有绑定了特定 appKey 的应用才会应用对应的水印配置。
