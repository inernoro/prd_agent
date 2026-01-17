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
/// Desktop 桌面客户端
/// </summary>
public static class Desktop
{
    public const string AppName = "PRD Agent Desktop";
    
    public static class Chat
    {
        [AppCallerMetadata(
            "聊天发送消息-对话",
            "用户在桌面端发送聊天消息时使用对话模型",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Chat"
        )]
        public const string SendMessageChat = "prd-agent-desktop.chat.sendmessage::chat";
        
        [AppCallerMetadata(
            "聊天发送消息-意图识别",
            "快速识别用户消息意图",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Chat"
        )]
        public const string SendMessageIntent = "prd-agent-desktop.chat.sendmessage::intent";
        
        [AppCallerMetadata(
            "聊天-视觉理解",
            "整个聊天功能的视觉理解能力",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Chat"
        )]
        public const string ChatVision = "prd-agent-desktop.chat::vision";
    }
    
    public static class PRD
    {
        [AppCallerMetadata(
            "PRD分析-对话",
            "分析PRD文档内容，提取关键信息",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Document"
        )]
        public const string AnalysisChat = "prd-agent-desktop.prd.analysis::chat";
        
        [AppCallerMetadata(
            "PRD预览问答-对话",
            "PRD文档预览时的问答功能",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Document"
        )]
        public const string PreviewChat = "prd-agent-desktop.prd.preview::chat";
    }
    
    public static class Gap
    {
        [AppCallerMetadata(
            "Gap检测-对话",
            "检测对话中的信息缺口",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Analysis"
        )]
        public const string DetectionChat = "prd-agent-desktop.gap.detection::chat";
        
        [AppCallerMetadata(
            "Gap总结-对话",
            "总结Gap内容",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Analysis"
        )]
        public const string SummarizationChat = "prd-agent-desktop.gap.summarization::chat";
    }
}
    
/// <summary>
/// Visual Agent 视觉创作
/// </summary>
public static class VisualAgent
{
    public const string AppName = "Visual Agent";
    
    public static class Image
    {
        [AppCallerMetadata(
            "图片生成",
            "根据描述生成图片",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Image"
        )]
        public const string Generation = "visual-agent.image::generation";
        
        [AppCallerMetadata(
            "图片分析",
            "分析图片内容",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Image"
        )]
        public const string Vision = "visual-agent.image::vision";
        
        [AppCallerMetadata(
            "创意对话",
            "与AI讨论创意想法",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Image"
        )]
        public const string Chat = "visual-agent.image::chat";
    }
}

/// <summary>
/// Literary Agent 文学创作
/// </summary>
public static class LiteraryAgent
{
    public const string AppName = "Literary Agent";
    
    public static class Content
    {
        [AppCallerMetadata(
            "内容生成",
            "生成文学内容",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Content"
        )]
        public const string Chat = "literary-agent.content::chat";
        
        [AppCallerMetadata(
            "内容润色",
            "润色文学风格",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Content"
        )]
        public const string PolishingChat = "literary-agent.content.polishing::chat";
    }
    
    public static class Illustration
    {
        [AppCallerMetadata(
            "配图生成",
            "为内容生成配图",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Illustration"
        )]
        public const string Generation = "literary-agent.illustration::generation";
    }
}

/// <summary>
/// Open Platform 开放平台
/// </summary>
public static class OpenPlatform
{
    public const string AppName = "Open Platform";
    
    public static class Proxy
    {
        [AppCallerMetadata(
            "聊天代理",
            "开放平台的LLM聊天代理",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Proxy"
        )]
        public const string Chat = "open-platform-agent.proxy::chat";
        
        [AppCallerMetadata(
            "向量嵌入代理",
            "开放平台的向量嵌入服务",
            ModelTypes = new[] { ModelTypes.Embedding },
            Category = "Proxy"
        )]
        public const string Embedding = "open-platform-agent.proxy::embedding";
        
        [AppCallerMetadata(
            "重排序代理",
            "开放平台的重排序服务",
            ModelTypes = new[] { ModelTypes.Rerank },
            Category = "Proxy"
        )]
        public const string Rerank = "open-platform-agent.proxy::rerank";
    }
}

/// <summary>
/// Admin 管理后台
/// </summary>
public static class Admin
{
    public const string AppName = "PRD Agent Web";
    
    public static class Lab
    {
        [AppCallerMetadata(
            "实验室-对话测试",
            "实验室功能的对话模型测试",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Testing"
        )]
        public const string Chat = "prd-agent-web.lab::chat";
        
        [AppCallerMetadata(
            "实验室-视觉测试",
            "实验室功能的视觉模型测试",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Testing"
        )]
        public const string Vision = "prd-agent-web.lab::vision";
        
        [AppCallerMetadata(
            "实验室-生成测试",
            "实验室功能的生成模型测试",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Testing"
        )]
        public const string Generation = "prd-agent-web.lab::generation";
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
