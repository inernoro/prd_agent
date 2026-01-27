using System;

namespace PrdAgent.Core.Attributes;

/// <summary>
/// 标识 MongoDB 实体类所属的应用（用于数据管理页面的应用分组显示）
/// - 每个实体类可以标注一个或多个 AppOwnership 特性
/// - 如果没有标注，则显示为"无应用"
/// - 如果标注多个，则表示该实体被多个应用共享
/// </summary>
[AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
public sealed class AppOwnershipAttribute : Attribute
{
    /// <summary>
    /// 应用名称（如 "prd-agent"、"visual-agent"、"literary-agent"）
    /// </summary>
    public string AppName { get; }

    /// <summary>
    /// 应用显示名称（中文名，用于 UI 展示）
    /// </summary>
    public string DisplayName { get; }

    /// <summary>
    /// 是否为主要归属（当实体被多应用共享时，标识主要归属）
    /// </summary>
    public bool IsPrimary { get; set; } = false;

    /// <summary>
    /// 构造函数
    /// </summary>
    /// <param name="appName">应用标识（kebab-case 格式，如 "prd-agent"）</param>
    /// <param name="displayName">应用显示名称（中文名）</param>
    public AppOwnershipAttribute(string appName, string displayName)
    {
        AppName = appName ?? throw new ArgumentNullException(nameof(appName));
        DisplayName = displayName ?? throw new ArgumentNullException(nameof(displayName));
    }
}

/// <summary>
/// 预定义的应用名称常量
/// </summary>
public static class AppNames
{
    /// <summary>PRD Agent - PRD 智能解读与问答</summary>
    public const string PrdAgent = "prd-agent";
    public const string PrdAgentDisplay = "PRD Agent";

    /// <summary>Visual Agent - 高级视觉创作工作区</summary>
    public const string VisualAgent = "visual-agent";
    public const string VisualAgentDisplay = "视觉创作";

    /// <summary>Literary Agent - 文章配图、文学创作场景</summary>
    public const string LiteraryAgent = "literary-agent";
    public const string LiteraryAgentDisplay = "文学创作";

    /// <summary>Model Lab - 模型实验室</summary>
    public const string ModelLab = "model-lab";
    public const string ModelLabDisplay = "模型实验室";

    /// <summary>Open Platform - 开放平台</summary>
    public const string OpenPlatform = "open-platform";
    public const string OpenPlatformDisplay = "开放平台";

    /// <summary>Desktop - 桌面客户端</summary>
    public const string Desktop = "desktop";
    public const string DesktopDisplay = "桌面客户端";

    /// <summary>System - 系统核心（用户、权限、配置等）</summary>
    public const string System = "system";
    public const string SystemDisplay = "系统核心";

    /// <summary>Watermark - 水印系统</summary>
    public const string Watermark = "watermark";
    public const string WatermarkDisplay = "水印系统";

    /// <summary>LLM - LLM 配置与日志</summary>
    public const string Llm = "llm";
    public const string LlmDisplay = "LLM 配置";
}
