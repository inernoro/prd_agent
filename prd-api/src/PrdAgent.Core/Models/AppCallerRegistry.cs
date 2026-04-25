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
            "聊天-推荐追问",
            "对话完成后生成推荐追问建议（轻量模型）",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Chat"
        )]
        public const string SuggestedQuestions = "prd-agent-desktop.chat.suggested-questions::intent";
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

    public static class Guide
    {
        [AppCallerMetadata(
            "引导技能-对话",
            "引导用户完成操作或回答问题的技能模板执行",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Guide"
        )]
        public const string Chat = "prd-agent.guide::chat";
    }

    public static class Skill
    {
        [AppCallerMetadata(
            "技能提炼-对话",
            "从对话中提炼可复用的技能模板",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Skill"
        )]
        public const string SkillGen = "prd-agent.skill-gen::chat";
    }

    public static class Arena
    {
        [AppCallerMetadata(
            "竞技场对战-对话",
            "竞技场模式下 AI 对战推理",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Arena"
        )]
        public const string BattleChat = "prd-agent.arena.battle::chat";
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
            "提示词澄清",
            "将用户自由文本改写为明确的生图提示词",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "ImageGen"
        )]
        public const string Clarify = "visual-agent.image-gen.clarify::intent";

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

    public static class Scene
    {
        [AppCallerMetadata(
            "视觉创作-场景代码生成",
            "基于 Remotion 组件库为视觉创作视频分镜生成定制化视觉代码",
            ModelTypes = new[] { ModelTypes.Code },
            Category = "Video"
        )]
        public const string Codegen = "visual-agent.scene.codegen::code";
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

    public static class Scoring
    {
        [AppCallerMetadata(
            "缺陷批量评分",
            "AI 自动评估缺陷严重程度、修复难度、影响范围",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Scoring"
        )]
        public const string Chat = "defect-agent.scoring::chat";
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
            "对话交互",
            "百宝箱对话交互",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Orchestration"
        )]
        public const string Chat = "ai-toolbox.orchestration::chat";

        [AppCallerMetadata(
            "视觉理解",
            "百宝箱图片理解与视觉分析",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Orchestration"
        )]
        public const string Vision = "ai-toolbox.orchestration::vision";
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

    public static class WebpageGenerator
    {
        [AppCallerMetadata(
            "工作流-网页报告生成",
            "工作流中使用LLM将结构化数据渲染为精美可下载的HTML网页报告(生成完整HTML/CSS/JS代码)",
            ModelTypes = new[] { ModelTypes.Code },
            Category = "Workflow"
        )]
        public const string Code = "workflow-agent.webpage-generator::code";
    }

    public static class ChatAssistant
    {
        [AppCallerMetadata(
            "工作流-对话助手",
            "通过自然语言对话创建和修改工作流配置，支持代码转工作流",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Workflow"
        )]
        public const string Chat = "workflow-agent.chat-assistant::chat";
    }

    public static class ErrorAnalyzer
    {
        [AppCallerMetadata(
            "工作流-错误分析",
            "分析工作流执行失败的原因并给出修复建议",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Workflow"
        )]
        public const string Chat = "workflow-agent.error-analyzer::chat";
    }

    public static class AiFill
    {
        [AppCallerMetadata(
            "工作流-AI参数填写",
            "根据舱类型Schema和上下文智能推荐配置参数值",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Workflow"
        )]
        public const string Chat = "workflow-agent.ai-fill::chat";
    }

    public static class CliAgentExecutor
    {
        [AppCallerMetadata(
            "工作流-CLI Agent页面生成",
            "根据规范、框架、风格要求生成完整的HTML页面，支持多轮迭代修改",
            ModelTypes = new[] { ModelTypes.Code },
            Category = "Workflow"
        )]
        public const string Code = "workflow-agent.cli-agent::code";
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

    /// <summary>
    /// 视频直出生成（OpenRouter 统一视频 API：Sora 2 / Veo 3.1 / Seedance / Wan 等）
    /// 跳过分镜流程，直接把 prompt 交给视频大模型生成 MP4
    /// </summary>
    public static class VideoGen
    {
        [AppCallerMetadata(
            "视频直出",
            "直接调用视频大模型（Wan / Seedance / Veo / Sora）从 prompt 生成 MP4",
            ModelTypes = new[] { ModelTypes.VideoGen },
            Category = "Video"
        )]
        public const string Generate = "video-agent.videogen::video-gen";
    }

    public static class Audio
    {
        [AppCallerMetadata(
            "视频旁白-语音合成",
            "将分镜旁白文本合成为 TTS 语音音频",
            ModelTypes = new[] { ModelTypes.Tts },
            Category = "Video"
        )]
        public const string Tts = "video-agent.audio::tts";
    }

    public static class Scene
    {
        [AppCallerMetadata(
            "视频场景-代码生成",
            "基于 Remotion 组件库和动效工具为分镜生成定制化视觉代码",
            ModelTypes = new[] { ModelTypes.Code },
            Category = "Video"
        )]
        public const string Codegen = "video-agent.scene.codegen::code";
    }

    /// <summary>
    /// 视频转文档 - 语音转写 + 多模态分析（帧+文字→结构化文档）
    /// </summary>
    public static class VideoToDoc
    {
        [AppCallerMetadata(
            "视频转文档-语音转写",
            "将视频音频转换为带时间戳的文字（ASR）",
            ModelTypes = new[] { ModelTypes.Asr },
            Category = "Video"
        )]
        public const string Transcribe = "video-agent.v2d.transcribe::asr";

        [AppCallerMetadata(
            "视频转文档-分析",
            "分析视频关键帧和转写文本，生成结构化文档",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "Video"
        )]
        public const string Analyze = "video-agent.v2d.analyze::vision";

    }

    public static class VideoToText
    {
        [AppCallerMetadata(
            "视频转文字-对话",
            "将视频内容转换为文字描述",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Video"
        )]
        public const string Chat = "video-agent.video-to-text::chat";
    }

    public static class TextToCopy
    {
        [AppCallerMetadata(
            "文案生成-对话",
            "根据视频内容生成营销文案",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Video"
        )]
        public const string Chat = "video-agent.text-to-copy::chat";
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

    public static class Polish
    {
        [AppCallerMetadata(
            "日常记录条目润色",
            "对单条日常记录原文做表达润色（更简洁、专业、具体）",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Report"
        )]
        public const string ItemRefine = "report-agent.daily-log.polish::chat";
    }

    /// <summary>
    /// 周报海报工坊 —— 登录后主页弹窗轮播海报的 AI 向导
    /// </summary>
    public static class WeeklyPoster
    {
        [AppCallerMetadata(
            "周报海报-自动拆页",
            "把周报 / changelog 拆成 4-6 页海报（标题/正文/imagePrompt/accentColor）",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Report"
        )]
        public const string Autopilot = "report-agent.weekly-poster.autopilot::chat";

        [AppCallerMetadata(
            "周报海报-配图生成",
            "为海报某一页根据 imagePrompt 生成配图（文生图）",
            ModelTypes = new[] { ModelTypes.ImageGen },
            Category = "Report"
        )]
        public const string Image = "report-agent.weekly-poster.image::generation";
    }
}

/// <summary>
/// Transcript Agent 音视频转录
/// </summary>
public static class TranscriptAgent
{
    public const string AppName = "Transcript Agent";

    public static class Transcribe
    {
        [AppCallerMetadata(
            "音视频转录",
            "将音视频内容转换为带时间轴的文字",
            ModelTypes = new[] { ModelTypes.Asr },
            Category = "Transcription"
        )]
        public const string Audio = "transcript-agent.transcribe::asr";
    }

    public static class Copywrite
    {
        [AppCallerMetadata(
            "模板转文案",
            "将转录文本按模板转换为结构化文案",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Transcription"
        )]
        public const string Generate = "transcript-agent.copywrite::chat";
    }
}

/// <summary>
/// 知识库（文档空间）
/// </summary>
public static class DocumentStoreAgent
{
    public const string AppName = "知识库";

    public static class Subtitle
    {
        [AppCallerMetadata(
            "知识库字幕生成-音频",
            "将音视频文件直译成带时间戳的字幕 Markdown",
            ModelTypes = new[] { ModelTypes.Asr },
            Category = "DocumentStore"
        )]
        public const string Audio = "document-store.subtitle::asr";

        [AppCallerMetadata(
            "知识库字幕生成-图片",
            "对图片做 OCR/Vision 识别生成纯文字字幕",
            ModelTypes = new[] { ModelTypes.Vision },
            Category = "DocumentStore"
        )]
        public const string Vision = "document-store.subtitle::vision";
    }

    public static class Reprocess
    {
        [AppCallerMetadata(
            "知识库文档再加工",
            "基于已有文档/字幕按模板或自定义提示词生成新文档",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "DocumentStore"
        )]
        public const string Generate = "document-store.reprocess::chat";
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
        public const string AvailableModels = "admin.platforms.available-models::chat";

        [AppCallerMetadata(
            "刷新模型列表",
            "刷新平台模型列表缓存",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string RefreshModels = "admin.platforms.refresh-models::chat";

        [AppCallerMetadata(
            "重分类-拉取模型",
            "重分类前拉取平台可用模型",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string ReclassifyFetchModels = "admin.platforms.reclassify.fetch-models::chat";

        [AppCallerMetadata(
            "拉取平台模型",
            "通用拉取平台模型列表",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Management"
        )]
        public const string FetchModels = "admin.platforms.fetch-models::chat";

        [AppCallerMetadata(
            "模型重分类",
            "使用 AI 对平台可用模型进行分类（严格 JSON 输出）",
            ModelTypes = new[] { ModelTypes.Intent },
            Category = "Management"
        )]
        public const string Reclassify = "prd-agent-web.platforms.reclassify::intent";
    }

}

/// <summary>
/// Channel Adapter 渠道适配
/// </summary>
public static class ChannelAdapter
{
    public const string AppName = "Channel Adapter";

    public static class Email
    {
        [AppCallerMetadata(
            "邮件分类",
            "AI 分类邮件内容确定处理方式",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Channel"
        )]
        public const string Classify = "channel-adapter.email.classify::chat";

        [AppCallerMetadata(
            "邮件待办提取",
            "从邮件内容提取结构化待办事项",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Channel"
        )]
        public const string TodoExtract = "channel-adapter.email.todo-extract::chat";
    }
}

/// <summary>
/// System 系统级调用
/// </summary>
public static class System
{
    public static class HealthProbe
    {
        [AppCallerMetadata(
            "模型池探活",
            "后台自动探活不健康模型端点，非用户触发",
            ModelTypes = new[] { ModelTypes.Chat, ModelTypes.Intent, ModelTypes.Vision, ModelTypes.ImageGen },
            Category = "System"
        )]
        public const string Chat = "system.health-probe::chat";

        [AppCallerMetadata(
            "模型池探活-意图",
            "后台自动探活意图模型端点",
            ModelTypes = new[] { ModelTypes.Chat, ModelTypes.Intent, ModelTypes.Vision, ModelTypes.ImageGen },
            Category = "System"
        )]
        public const string Intent = "system.health-probe::intent";

        [AppCallerMetadata(
            "模型池探活-视觉",
            "后台自动探活视觉模型端点",
            ModelTypes = new[] { ModelTypes.Chat, ModelTypes.Intent, ModelTypes.Vision, ModelTypes.ImageGen },
            Category = "System"
        )]
        public const string Vision = "system.health-probe::vision";

        [AppCallerMetadata(
            "模型池探活-生图",
            "后台自动探活生图模型端点",
            ModelTypes = new[] { ModelTypes.Chat, ModelTypes.Intent, ModelTypes.Vision, ModelTypes.ImageGen },
            Category = "System"
        )]
        public const string Generation = "system.health-probe::generation";
    }
}

public static class ReviewAgent
{
    public const string AppName = "Review Agent";

    public static class Review
    {
        [AppCallerMetadata(
            "产品方案评审",
            "对上传的产品方案进行多维度 AI 评审打分",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Review"
        )]
        public const string Chat = "review-agent.review::chat";
    }
}

public static class PrReview
{
    public const string AppName = "PR Review";

    public static class Summary
    {
        [AppCallerMetadata(
            "PR 变更摘要",
            "对 GitHub PR 的描述 + 代码变更生成 30 秒看懂的 Markdown 摘要（一句话/关键改动/主要影响/审查建议）",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Review"
        )]
        public const string Chat = "pr-review.summary::chat";
    }

    public static class Alignment
    {
        [AppCallerMetadata(
            "PR 对齐度检查",
            "对比 PR 描述与实际代码变更，输出对齐度分数 + 四色结构化章节（已落实/没提但动/提了没见到/架构师关注点）",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Review"
        )]
        public const string Chat = "pr-review.alignment::chat";
    }
}

public static class EmergenceExplorer
{
    public const string AppName = "Emergence Explorer";

    public static class Explore
    {
        [AppCallerMetadata(
            "涌现探索",
            "从种子文档出发，基于现实锚点向下探索子功能",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Emergence"
        )]
        public const string Chat = "emergence-explorer.explore::chat";
    }

    public static class Emerge
    {
        [AppCallerMetadata(
            "涌现组合",
            "交叉组合多个已有节点，发现涌现价值",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Emergence"
        )]
        public const string Chat = "emergence-explorer.emerge::chat";
    }
}

/// <summary>
/// Skill Agent 技能引导创建
/// </summary>
public static class SkillAgent
{
    public static class Guide
    {
        [AppCallerMetadata(
            "技能引导-对话",
            "引导用户逐步创建技能的对话模型",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Skill"
        )]
        public const string Chat = "skill-agent.guide::chat";
    }

    public static class Export
    {
        [AppCallerMetadata(
            "技能导出-生成说明",
            "为技能导出包生成 README 和使用示例",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Skill"
        )]
        public const string GenerateReadme = "skill-agent.export.readme::chat";
    }
}

/// <summary>
/// PA Agent 私人执行助理
/// </summary>
public static class PaAgent
{
    public static class Chat
    {
        [AppCallerMetadata(
            "私人助理-对话",
            "MBB 级执行助理：MECE 任务拆解、四象限排序、执行建议",
            ModelTypes = new[] { ModelTypes.Chat },
            Category = "Assistant"
        )]
        public const string Conversation = "pa-agent.chat::chat";
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
