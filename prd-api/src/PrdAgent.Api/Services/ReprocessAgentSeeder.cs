using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 启动时把内置「文档再加工·智能体」种入 reprocess_agents 集合。
///
/// 这些智能体对应本系统已有的几个通用 Agent 形态（文学/评审/周报/缺陷分析等），
/// 给「文档再加工」Chat 抽屉提供一键调用入口。用户可以在抽屉里再 POST 新建自己的智能体。
/// 已存在同名 Key 时仅更新 SystemPrompt / Label / Description / Description 字段（保持 system 智能体可演进）。
/// </summary>
public class ReprocessAgentSeeder : IHostedService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ReprocessAgentSeeder> _logger;

    public ReprocessAgentSeeder(IServiceScopeFactory scopeFactory, ILogger<ReprocessAgentSeeder> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

            var seeds = GetBuiltinAgents();
            foreach (var seed in seeds)
            {
                var filter = Builders<ReprocessAgent>.Filter.Eq(a => a.Key, seed.Key);
                var update = Builders<ReprocessAgent>.Update
                    .Set(a => a.Label, seed.Label)
                    .Set(a => a.Description, seed.Description)
                    .Set(a => a.SystemPrompt, seed.SystemPrompt)
                    .Set(a => a.Visibility, ReprocessAgentVisibility.System)
                    .Set(a => a.OwnerUserId, (string?)null)
                    .Set(a => a.SortOrder, seed.SortOrder)
                    .Set(a => a.UpdatedAt, DateTime.UtcNow)
                    .SetOnInsert(a => a.Id, Guid.NewGuid().ToString("N"))
                    .SetOnInsert(a => a.Key, seed.Key)
                    .SetOnInsert(a => a.CreatedAt, DateTime.UtcNow);

                await db.ReprocessAgents.UpdateOneAsync(filter, update,
                    new UpdateOptions { IsUpsert = true }, cancellationToken: cancellationToken);
            }

            _logger.LogInformation("[reprocess-agent] Seeded {Count} built-in agents", seeds.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[reprocess-agent] Seed failed (non-fatal)");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static IReadOnlyList<ReprocessAgent> GetBuiltinAgents() => new List<ReprocessAgent>
    {
        new()
        {
            Key = "literary-assistant",
            Label = "文学创作",
            Description = "把文档改写成有感染力的叙事/散文/故事化版本",
            SortOrder = 10,
            SystemPrompt =
                "你是本系统的「文学创作助手」。任务：把用户给的原始内容改写成更具叙事张力的文学化版本。要求：" +
                "1) 用画面感和细节代替罗列；" +
                "2) 保留原文核心事实/数据不能篡改；" +
                "3) 输出 Markdown，可以用小标题切分场景；" +
                "4) 风格平实有力，不堆砌华丽辞藻。",
        },
        new()
        {
            Key = "review-agent",
            Label = "产品评审员",
            Description = "以产品评审视角逐条给出评分与改进建议",
            SortOrder = 20,
            SystemPrompt =
                "你是本系统的「产品评审员智能体」。任务：把用户给的文档当成一份产品方案/PRD，进行专业评审。要求：" +
                "1) 输出 Markdown，包含：## 总体评分（1-10 分 + 一句话定调）、## 亮点（最多 5 条）、## 风险（最多 5 条）、## 改进建议（最多 5 条）；" +
                "2) 每条改进建议必须指向原文具体段落或措辞；" +
                "3) 不要无凭据吹捧，也不要无凭据否定；" +
                "4) 文末加一行明确结论：可发布 / 需修订后发布 / 建议重做。",
        },
        new()
        {
            Key = "report-agent",
            Label = "周报助手",
            Description = "把文档/日志整理为一份可发出去的周报",
            SortOrder = 30,
            SystemPrompt =
                "你是本系统的「周报助手智能体」。任务：把用户给的原始内容整理成一份对外可发的周报。要求：" +
                "1) Markdown 格式，章节固定：# 本周综述、## 完成事项、## 进行中、## 下周计划、## 风险与求助；" +
                "2) 「完成事项」用 - 列表，每条不超过两行，必要时加 (责任人) 标注；" +
                "3) 严格基于原文事实，不编造；" +
                "4) 末尾不要客套话，干净收束。",
        },
        new()
        {
            Key = "defect-analyst",
            Label = "缺陷分析员",
            Description = "把文档/日志中的问题抽取为结构化缺陷清单",
            SortOrder = 40,
            SystemPrompt =
                "你是本系统的「缺陷分析员智能体」。任务：从用户给的原始内容里抽出潜在缺陷/Bug/风险，给出结构化清单。要求：" +
                "1) Markdown 表格输出，列：编号 / 现象 / 影响面 / 复现步骤（若有） / 优先级（P0-P3） / 建议修复方向；" +
                "2) 没有可识别的缺陷时明确写「未发现明显缺陷」，不要硬凑；" +
                "3) 严格基于原文事实；" +
                "4) 表格下方可加一段「整体观察」小结，3-5 句话。",
        },
    };
}
