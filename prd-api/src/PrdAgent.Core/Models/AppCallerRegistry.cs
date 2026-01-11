using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace PrdAgent.Core.Models;

/// <summary>
/// 应用调用者注册表（集中管理所有应用定义）
/// </summary>
public static class AppCallerRegistry
{
    /// <summary>
    /// PRD Desktop 应用
    /// </summary>
    public static class PrdDesktop
    {
        public const string AppName = "PrdDesktop";
        
        public static class Chat
        {
            [AppCallerMetadata(
                "桌面端-聊天消息",
                "用户在桌面端发送聊天消息",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Chat"
            )]
            public const string SendMessage = "PrdDesktop.Chat.SendMessage";
            
            [AppCallerMetadata(
                "桌面端-意图识别",
                "快速识别用户消息意图",
                ModelTypes = new[] { ModelTypes.Intent },
                Category = "Chat"
            )]
            public const string IntentRecognition = "PrdDesktop.Chat.IntentRecognition";
        }
        
        public static class PRD
        {
            [AppCallerMetadata(
                "桌面端-PRD分析",
                "分析PRD文档内容，提取关键信息",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Document"
            )]
            public const string Analyze = "PrdDesktop.PRD.Analyze";
            
            [AppCallerMetadata(
                "桌面端-PRD预览问答",
                "PRD文档预览时的问答功能",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Document"
            )]
            public const string Preview = "PrdDesktop.PRD.Preview";
        }
        
        public static class Gap
        {
            [AppCallerMetadata(
                "桌面端-Gap检测",
                "检测对话中的信息缺口",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Analysis"
            )]
            public const string Detect = "PrdDesktop.Gap.Detect";
            
            [AppCallerMetadata(
                "桌面端-Gap总结",
                "总结Gap内容",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Analysis"
            )]
            public const string Summarize = "PrdDesktop.Gap.Summarize";
        }
        
        public static class VisualAgent
        {
            [AppCallerMetadata(
                "桌面端-视觉Agent分析",
                "视觉创作Agent的图片分析",
                ModelTypes = new[] { ModelTypes.Vision, ModelTypes.Chat },
                Category = "Agent"
            )]
            public const string Analyze = "PrdDesktop.VisualAgent.Analyze";
            
            [AppCallerMetadata(
                "桌面端-视觉Agent生图",
                "视觉创作Agent的图片生成",
                ModelTypes = new[] { ModelTypes.ImageGen },
                Category = "Agent"
            )]
            public const string GenerateImage = "PrdDesktop.VisualAgent.GenerateImage";
        }
        
        public static class LiteraryAgent
        {
            [AppCallerMetadata(
                "桌面端-文学Agent生成",
                "文学创作Agent的内容生成",
                ModelTypes = new[] { ModelTypes.Chat, ModelTypes.ImageGen },
                Category = "Agent"
            )]
            public const string Generate = "PrdDesktop.LiteraryAgent.Generate";
        }
    }
    
    /// <summary>
    /// PRD Admin 应用
    /// </summary>
    public static class PrdAdmin
    {
        public const string AppName = "PrdAdmin";
        
        public static class Chat
        {
            [AppCallerMetadata(
                "管理后台-聊天消息",
                "管理员在后台测试聊天功能",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Chat"
            )]
            public const string SendMessage = "PrdAdmin.Chat.SendMessage";
        }
        
        public static class Lab
        {
            [AppCallerMetadata(
                "管理后台-实验室测试",
                "实验室功能的模型测试",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Testing"
            )]
            public const string Experiment = "PrdAdmin.Lab.Experiment";
        }
    }
    
    /// <summary>
    /// 开放平台应用
    /// </summary>
    public static class OpenPlatform
    {
        public const string AppName = "OpenPlatform";
        
        public static class Proxy
        {
            [AppCallerMetadata(
                "开放平台-聊天代理",
                "开放平台的LLM聊天代理",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Proxy"
            )]
            public const string Chat = "OpenPlatform.Proxy.Chat";
            
            [AppCallerMetadata(
                "开放平台-向量嵌入",
                "开放平台的向量嵌入服务",
                ModelTypes = new[] { ModelTypes.Embedding },
                Category = "Proxy"
            )]
            public const string Embedding = "OpenPlatform.Proxy.Embedding";
        }
    }
}

/// <summary>
/// 应用调用者元数据标记
/// </summary>
[AttributeUsage(AttributeTargets.Field, AllowMultiple = false)]
public class AppCallerMetadataAttribute : Attribute
{
    /// <summary>显示名称</summary>
    public string DisplayName { get; set; }
    
    /// <summary>描述</summary>
    public string Description { get; set; }
    
    /// <summary>需要的模型类型</summary>
    public string[] ModelTypes { get; set; } = Array.Empty<string>();
    
    /// <summary>分类</summary>
    public string Category { get; set; } = "General";
    
    /// <summary>优先级（数字越小优先级越高）</summary>
    public int Priority { get; set; } = 100;
    
    public AppCallerMetadataAttribute(string displayName, string description)
    {
        DisplayName = displayName;
        Description = description;
    }
}

/// <summary>
/// 应用定义
/// </summary>
public class AppCallerDefinition
{
    public string AppCode { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string[] ModelTypes { get; set; } = Array.Empty<string>();
    public string Category { get; set; } = "General";
    public int Priority { get; set; } = 100;
}

/// <summary>
/// 应用注册服务
/// </summary>
public static class AppCallerRegistrationService
{
    private static List<AppCallerDefinition>? _cachedDefinitions;
    
    /// <summary>
    /// 获取所有应用定义（带缓存）
    /// </summary>
    public static List<AppCallerDefinition> GetAllDefinitions()
    {
        if (_cachedDefinitions != null)
        {
            return _cachedDefinitions;
        }
        
        var definitions = new List<AppCallerDefinition>();
        var registryType = typeof(AppCallerRegistry);
        
        ScanType(registryType, definitions);
        
        _cachedDefinitions = definitions;
        return definitions;
    }
    
    /// <summary>
    /// 根据 AppCode 查找定义
    /// </summary>
    public static AppCallerDefinition? FindByAppCode(string appCode)
    {
        return GetAllDefinitions().FirstOrDefault(d => d.AppCode == appCode);
    }
    
    /// <summary>
    /// 递归扫描类型，提取应用定义
    /// </summary>
    private static void ScanType(Type type, List<AppCallerDefinition> definitions)
    {
        // 扫描嵌套类
        foreach (var nestedType in type.GetNestedTypes(BindingFlags.Public | BindingFlags.Static))
        {
            // 扫描常量字段
            foreach (var field in nestedType.GetFields(BindingFlags.Public | BindingFlags.Static | BindingFlags.FlattenHierarchy))
            {
                if (field.IsLiteral && !field.IsInitOnly && field.FieldType == typeof(string))
                {
                    var attr = field.GetCustomAttribute<AppCallerMetadataAttribute>();
                    if (attr != null)
                    {
                        var appCode = (string?)field.GetValue(null);
                        if (!string.IsNullOrEmpty(appCode))
                        {
                            definitions.Add(new AppCallerDefinition
                            {
                                AppCode = appCode,
                                DisplayName = attr.DisplayName,
                                Description = attr.Description,
                                ModelTypes = attr.ModelTypes,
                                Category = attr.Category,
                                Priority = attr.Priority
                            });
                        }
                    }
                }
            }
            
            // 递归扫描子类
            ScanType(nestedType, definitions);
        }
    }
}
