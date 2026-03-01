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

    public static class GroupName
    {
        [AppCallerMetadata(
            "群组名称建议-意图",
            "根据PRD内容建议群组名称",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Utility"
        )]
        public const string SuggestIntent = "prd-agent-desktop.group-name.suggest::intent";
    }

    public static class PreviewAsk
    {
        [AppCallerMetadata(
            "预览问答-对话",
            "PRD预览时的章节问答",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Document"
        )]
        public const string SectionChat = "prd-agent-desktop.preview-ask.section::chat";
    }

    public static class Skill
    {
        [AppCallerMetadata(
            "技能执行-对话",
            "通过技能系统执行用户技能",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Skill"
        )]
        public const string ExecuteChat = "prd-agent-desktop.skill.execute::chat";
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
        // 已移除通用的 Generation，请使用具体的 Text2Img / Img2Img / VisionGen

        [AppCallerMetadata(
            "文生图",
            "纯文本描述生成图片（无参考图）",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Image"
        )]
        public const string Text2Img = "visual-agent.image.text2img::generation";

        [AppCallerMetadata(
            "图生图（单图参考）",
            "单图参考生成（传统 img2img）",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Image"
        )]
        public const string Img2Img = "visual-agent.image.img2img::generation";

        [AppCallerMetadata(
            "多图参考生成",
            "多图参考生成（Vision API）",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Image"
        )]
        public const string VisionGen = "visual-agent.image.vision::generation";

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

        [AppCallerMetadata(
            "图片描述提取",
            "使用 VLM 提取图片的视觉描述（用于多图组合）",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Image"
        )]
        public const string Describe = "visual-agent.image.describe::vision";
    }

    public static class Workspace
    {
        [AppCallerMetadata(
            "工作区标题生成",
            "根据提示词生成工作区标题",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Workspace"
        )]
        public const string Title = "visual-agent.workspace-title::intent";
    }

    public static class DrawingBoard
    {
        [AppCallerMetadata(
            "手绘板对话",
            "手绘板中的创意对话交互，AI 生成字符画参考",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "DrawingBoard"
        )]
        public const string Chat = "visual-agent.drawing-board::chat";
    }

    public static class Compose
    {
        [AppCallerMetadata(
            "多图组合-意图解析",
            "解析用户的多图组合指令，生成英文 Prompt",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Compose"
        )]
        public const string Intent = "visual-agent.compose::vision";

        [AppCallerMetadata(
            "多图组合-图片生成",
            "根据解析后的 Prompt 生成组合图片",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Compose"
        )]
        public const string Generation = "visual-agent.compose::generation";
    }

    public static class ImageGen
    {
        [AppCallerMetadata(
            "图片生成规划",
            "根据文档内容规划需要生成的图片",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "ImageGen"
        )]
        public const string Plan = "visual-agent.image-gen.plan::intent";

        [AppCallerMetadata(
            "图片生成",
            "单张图片生成",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "ImageGen"
        )]
        public const string Generate = "visual-agent.image-gen.generate::generation";

        [AppCallerMetadata(
            "批量图片生成",
            "批量生成多张图片",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "ImageGen"
        )]
        public const string BatchGenerate = "visual-agent.image-gen.batch-generate::generation";

        [AppCallerMetadata(
            "图片风格提取",
            "从参考图片提取风格描述",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "ImageGen"
        )]
        public const string ExtractStyle = "visual-agent.image-gen.extract-style::vision";
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
            "配图-文生图",
            "纯文本描述生成配图（无参考图）",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Illustration"
        )]
        public const string Text2Img = "literary-agent.illustration.text2img::generation";

        [AppCallerMetadata(
            "配图-图生图",
            "使用风格参考图生成配图",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Illustration"
        )]
        public const string Img2Img = "literary-agent.illustration.img2img::generation";
    }

    public static class Prompt
    {
        [AppCallerMetadata(
            "风格提示词优化",
            "AI 提取旧提示词中的风格描述，去除格式指令",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Prompt"
        )]
        public const string Optimize = "literary-agent.prompt.optimize::chat";
    }
}

/// <summary>
/// Defect Agent 缺陷管理
/// </summary>
public static class DefectAgent
{
    public const string AppName = "Defect Agent";

    public static class Review
    {
        [AppCallerMetadata(
            "缺陷审核对话",
            "AI 审核缺陷信息是否完整",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Review"
        )]
        public const string Chat = "defect-agent.review::chat";
    }

    public static class Extract
    {
        [AppCallerMetadata(
            "信息提取结构化",
            "从用户描述中提取结构化缺陷信息",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Extract"
        )]
        public const string Chat = "defect-agent.extract::chat";
    }

    public static class Polish
    {
        [AppCallerMetadata(
            "缺陷描述润色",
            "AI 润色/填充缺陷描述内容",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Polish"
        )]
        public const string Chat = "defect-agent.polish::chat";
    }

    public static class AnalyzeImage
    {
        [AppCallerMetadata(
            "截图缺陷分析",
            "VLM 分析截图中标记的缺陷内容",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Analyze"
        )]
        public const string Vision = "defect-agent.analyze-image::vision";
    }
}

/// <summary>
/// Tutorial Email 教程邮件
/// </summary>
public static class TutorialEmail
{
    public const string AppName = "Tutorial Email";

    public static class Generate
    {
        [AppCallerMetadata(
            "教程邮件生成",
            "AI 自动生成教程邮件 HTML 内容",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Email"
        )]
        public const string Chat = "tutorial-email.generate::chat";
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
/// AI Toolbox 百宝箱
/// </summary>
public static class AiToolbox
{
    public const string AppName = "AI Toolbox";

    public static class Orchestration
    {
        [AppCallerMetadata(
            "意图识别",
            "识别用户输入的意图，决定调用哪个 Agent",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Orchestration"
        )]
        public const string Intent = "ai-toolbox.orchestration::intent";

        [AppCallerMetadata(
            "任务规划",
            "将复杂任务分解为多个子任务",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Orchestration"
        )]
        public const string Planning = "ai-toolbox.orchestration.planning::chat";

        [AppCallerMetadata(
            "对话交互",
            "百宝箱对话交互",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Orchestration"
        )]
        public const string Chat = "ai-toolbox.orchestration::chat";
    }

    public static class Agent
    {
        [AppCallerMetadata(
            "Agent 执行",
            "调用具体 Agent 执行任务",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Agent"
        )]
        public const string Execute = "ai-toolbox.agent.execute::chat";
    }

    /// <summary>
    /// 各 Agent 的 AppCallerCode
    /// </summary>
    public static class Agents
    {
        [AppCallerMetadata(
            "PRD Agent 对话",
            "PRD 分析、缺口检测、问题解答",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Agent"
        )]
        public const string PrdChat = "ai-toolbox.agent.prd::chat";

        [AppCallerMetadata(
            "Visual Agent 对话",
            "视觉创作对话交互",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Agent"
        )]
        public const string VisualChat = "ai-toolbox.agent.visual::chat";

        [AppCallerMetadata(
            "Visual Agent 视觉理解",
            "图片描述、视觉理解",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Agent"
        )]
        public const string VisualVision = "ai-toolbox.agent.visual::vision";

        [AppCallerMetadata(
            "Visual Agent 图片生成",
            "文生图、图生图",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Agent"
        )]
        public const string VisualGeneration = "ai-toolbox.agent.visual::generation";

        [AppCallerMetadata(
            "Literary Agent 对话",
            "文学创作、写作、润色",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Agent"
        )]
        public const string LiteraryChat = "ai-toolbox.agent.literary::chat";

        [AppCallerMetadata(
            "Defect Agent 对话",
            "缺陷提取、分类、报告",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Agent"
        )]
        public const string DefectChat = "ai-toolbox.agent.defect::chat";
    }
}

/// <summary>
/// Workflow Agent 工作流自动化
/// </summary>
public static class WorkflowAgent
{
    public const string AppName = "Workflow Agent";

    public static class LlmAnalyzer
    {
        [AppCallerMetadata(
            "工作流-LLM分析",
            "工作流中使用大语言模型对数据进行智能分析、总结、分类",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Workflow"
        )]
        public const string Chat = "workflow-agent.llm-analyzer::chat";
    }

    public static class ReportGenerator
    {
        [AppCallerMetadata(
            "工作流-报告生成",
            "工作流中使用LLM将结构化数据渲染为可读报告",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Workflow"
        )]
        public const string Chat = "workflow-agent.report-generator::chat";
    }
}

/// <summary>
/// Video Agent 文章转视频
/// </summary>
public static class VideoAgent
{
    public const string AppName = "Video Agent";

    public static class Script
    {
        [AppCallerMetadata(
            "视频脚本生成",
            "将文章内容拆分为视频镜头脚本",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Video"
        )]
        public const string Chat = "video-agent.script::chat";
    }

    public static class Image
    {
        [AppCallerMetadata(
            "视频场景-文生图",
            "根据分镜画面描述生成预览图",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Video"
        )]
        public const string Text2Img = "video-agent.image.text2img::generation";
    }
}

/// <summary>
/// Report Agent 周报管理
/// </summary>
public static class ReportAgent
{
    public const string AppName = "Report Agent";

    public static class Generate
    {
        [AppCallerMetadata(
            "周报草稿生成",
            "基于采集数据自动生成周报草稿",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Report"
        )]
        public const string Draft = "report-agent.generate::chat";
    }

    public static class Polish
    {
        [AppCallerMetadata(
            "周报内容润色",
            "对手动编写的周报内容做表达优化",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Report"
        )]
        public const string Content = "report-agent.polish::chat";
    }

    public static class Aggregate
    {
        [AppCallerMetadata(
            "团队周报汇总",
            "将团队成员周报汇总为管理摘要",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Report"
        )]
        public const string Summary = "report-agent.aggregate::chat";
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

    public static class ModelLab
    {
        [AppCallerMetadata(
            "模型实验室-运行测试",
            "模型实验室功能的测试运行",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Testing"
        )]
        public const string Run = "prd-agent-web.model-lab.run::chat";
    }

    public static class Platforms
    {
        [AppCallerMetadata(
            "查询可用模型",
            "查询平台可用模型列表",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string AvailableModels = "admin.platforms.available-models";

        [AppCallerMetadata(
            "刷新模型列表",
            "刷新平台模型列表缓存",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string RefreshModels = "admin.platforms.refresh-models";

        [AppCallerMetadata(
            "重分类-拉取模型",
            "重分类前拉取平台可用模型",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string ReclassifyFetchModels = "admin.platforms.reclassify.fetch-models";

        [AppCallerMetadata(
            "拉取平台模型",
            "通用拉取平台模型列表",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string FetchModels = "admin.platforms.fetch-models";

        [AppCallerMetadata(
            "模型重分类",
            "使用 AI 对平台可用模型进行分类（严格 JSON 输出）",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Management"
        )]
        public const string Reclassify = "prd-agent-web.platforms.reclassify::intent";
    }

    public static class Prompts
    {
        [AppCallerMetadata(
            "提示词优化",
            "使用 AI 优化提示词模板",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string Optimize = "prd-agent-web.prompts.optimize::chat";
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
