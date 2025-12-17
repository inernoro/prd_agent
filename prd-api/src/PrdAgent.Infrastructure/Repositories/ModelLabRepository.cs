using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// 大模型实验室仓储实现
/// </summary>
public class ModelLabRepository : IModelLabRepository
{
    private readonly IMongoCollection<ModelLabExperiment> _experiments;
    private readonly IMongoCollection<ModelLabRun> _runs;
    private readonly IMongoCollection<ModelLabRunItem> _items;
    private readonly IMongoCollection<ModelLabModelSet> _modelSets;

    public ModelLabRepository(
        IMongoCollection<ModelLabExperiment> experiments,
        IMongoCollection<ModelLabRun> runs,
        IMongoCollection<ModelLabRunItem> items,
        IMongoCollection<ModelLabModelSet> modelSets)
    {
        _experiments = experiments;
        _runs = runs;
        _items = items;
        _modelSets = modelSets;
    }

    public async Task<ModelLabExperiment> InsertExperimentAsync(ModelLabExperiment experiment)
    {
        experiment.CreatedAt = DateTime.UtcNow;
        experiment.UpdatedAt = experiment.CreatedAt;
        await _experiments.InsertOneAsync(experiment);
        return experiment;
    }

    public async Task<ModelLabExperiment?> GetExperimentAsync(string id, string ownerAdminId)
    {
        return await _experiments.Find(x => x.Id == id && x.OwnerAdminId == ownerAdminId).FirstOrDefaultAsync();
    }

    public async Task<List<ModelLabExperiment>> ListExperimentsAsync(string ownerAdminId, string? search, int page, int pageSize)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var filter = Builders<ModelLabExperiment>.Filter.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (!string.IsNullOrWhiteSpace(search))
        {
            // 简单 contains：用正则避免额外 text index 复杂度（后续可升级）
            filter &= Builders<ModelLabExperiment>.Filter.Regex(x => x.Name, new MongoDB.Bson.BsonRegularExpression(search.Trim(), "i"));
        }

        return await _experiments
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();
    }

    public async Task UpdateExperimentAsync(ModelLabExperiment experiment)
    {
        experiment.UpdatedAt = DateTime.UtcNow;
        await _experiments.ReplaceOneAsync(x => x.Id == experiment.Id && x.OwnerAdminId == experiment.OwnerAdminId, experiment);
    }

    public async Task<ModelLabModelSet> UpsertModelSetAsync(ModelLabModelSet modelSet)
    {
        var now = DateTime.UtcNow;
        if (string.IsNullOrWhiteSpace(modelSet.Id))
        {
            modelSet.Id = Guid.NewGuid().ToString();
        }
        if (modelSet.CreatedAt == default) modelSet.CreatedAt = now;
        modelSet.UpdatedAt = now;

        await _modelSets.ReplaceOneAsync(
            x => x.Id == modelSet.Id && x.OwnerAdminId == modelSet.OwnerAdminId,
            modelSet,
            new ReplaceOptions { IsUpsert = true });

        return modelSet;
    }

    public async Task<List<ModelLabModelSet>> ListModelSetsAsync(string ownerAdminId, string? search, int limit)
    {
        limit = Math.Clamp(limit, 1, 200);
        var filter = Builders<ModelLabModelSet>.Filter.Eq(x => x.OwnerAdminId, ownerAdminId);
        if (!string.IsNullOrWhiteSpace(search))
        {
            filter &= Builders<ModelLabModelSet>.Filter.Regex(x => x.Name, new MongoDB.Bson.BsonRegularExpression(search.Trim(), "i"));
        }

        return await _modelSets
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .ToListAsync();
    }

    public async Task<ModelLabModelSet?> GetModelSetAsync(string id, string ownerAdminId)
    {
        return await _modelSets.Find(x => x.Id == id && x.OwnerAdminId == ownerAdminId).FirstOrDefaultAsync();
    }

    public async Task<ModelLabRun> InsertRunAsync(ModelLabRun run)
    {
        run.StartedAt = DateTime.UtcNow;
        run.Status = ModelLabRunStatus.Running;
        await _runs.InsertOneAsync(run);
        return run;
    }

    public async Task UpdateRunAsync(ModelLabRun run)
    {
        await _runs.ReplaceOneAsync(x => x.Id == run.Id && x.OwnerAdminId == run.OwnerAdminId, run);
    }

    public async Task<ModelLabRun?> GetRunAsync(string id, string ownerAdminId)
    {
        return await _runs.Find(x => x.Id == id && x.OwnerAdminId == ownerAdminId).FirstOrDefaultAsync();
    }

    public async Task<List<ModelLabRun>> ListRunsByExperimentAsync(string ownerAdminId, string experimentId, int limit)
    {
        limit = Math.Clamp(limit, 1, 200);
        return await _runs
            .Find(x => x.OwnerAdminId == ownerAdminId && x.ExperimentId == experimentId)
            .SortByDescending(x => x.StartedAt)
            .Limit(limit)
            .ToListAsync();
    }

    public async Task<ModelLabRunItem> InsertRunItemAsync(ModelLabRunItem item)
    {
        item.StartedAt = DateTime.UtcNow;
        await _items.InsertOneAsync(item);
        return item;
    }

    public async Task UpdateRunItemAsync(ModelLabRunItem item)
    {
        await _items.ReplaceOneAsync(x => x.Id == item.Id && x.OwnerAdminId == item.OwnerAdminId, item);
    }

    public async Task<List<ModelLabRunItem>> ListRunItemsAsync(string ownerAdminId, string runId)
    {
        return await _items
            .Find(x => x.OwnerAdminId == ownerAdminId && x.RunId == runId)
            .SortBy(x => x.StartedAt)
            .ToListAsync();
    }
}


