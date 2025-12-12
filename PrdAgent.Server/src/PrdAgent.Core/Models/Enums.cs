namespace PrdAgent.Core.Models;

/// <summary>
/// 用户角色
/// </summary>
public enum UserRole
{
    /// <summary>产品经理</summary>
    PM,
    /// <summary>开发工程师</summary>
    DEV,
    /// <summary>测试工程师</summary>
    QA,
    /// <summary>超级管理员</summary>
    ADMIN
}

/// <summary>
/// 用户状态
/// </summary>
public enum UserStatus
{
    /// <summary>正常</summary>
    Active,
    /// <summary>禁用</summary>
    Disabled
}

/// <summary>
/// 交互模式
/// </summary>
public enum InteractionMode
{
    /// <summary>问答模式</summary>
    QA,
    /// <summary>引导讲解模式</summary>
    Guided
}

/// <summary>
/// 消息角色
/// </summary>
public enum MessageRole
{
    /// <summary>用户消息</summary>
    User,
    /// <summary>AI助手消息</summary>
    Assistant
}

/// <summary>
/// 内容缺失类型
/// </summary>
public enum GapType
{
    /// <summary>流程缺失</summary>
    FlowMissing,
    /// <summary>边界未定义</summary>
    BoundaryUndefined,
    /// <summary>异常未说明</summary>
    ExceptionUnhandled,
    /// <summary>数据格式不明确</summary>
    DataFormatUnclear,
    /// <summary>其他</summary>
    Other
}

/// <summary>
/// 缺失处理状态
/// </summary>
public enum GapStatus
{
    /// <summary>待处理</summary>
    Pending,
    /// <summary>已解决</summary>
    Resolved,
    /// <summary>已忽略</summary>
    Ignored
}

/// <summary>
/// 附件类型
/// </summary>
public enum AttachmentType
{
    /// <summary>图片</summary>
    Image,
    /// <summary>文档</summary>
    Document
}

/// <summary>
/// 引导控制动作
/// </summary>
public enum GuideAction
{
    /// <summary>下一步</summary>
    Next,
    /// <summary>上一步</summary>
    Previous,
    /// <summary>跳转到指定步骤</summary>
    GoTo,
    /// <summary>停止引导</summary>
    Stop
}

/// <summary>
/// 引导状态
/// </summary>
public enum GuideStatus
{
    /// <summary>进行中</summary>
    InProgress,
    /// <summary>已完成</summary>
    Completed,
    /// <summary>已停止</summary>
    Stopped
}





