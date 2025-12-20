using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 大模型实验室仓储（Admin 侧）
/// </summary>
public interface IModelLabRepository
{
    Task<ModelLabExperiment> InsertExperimentAsync(ModelLabExperiment experiment);
    Task<ModelLabExperiment?> GetExperimentAsync(string id, string ownerAdminId);
    Task<List<ModelLabExperiment>> ListExperimentsAsync(string ownerAdminId, string? search, int page, int pageSize);
    Task UpdateExperimentAsync(ModelLabExperiment experiment);
    Task<bool> DeleteExperimentAsync(string id, string ownerAdminId);

    Task<ModelLabModelSet> UpsertModelSetAsync(ModelLabModelSet modelSet);
    Task<List<ModelLabModelSet>> ListModelSetsAsync(string ownerAdminId, string? search, int limit);
    Task<ModelLabModelSet?> GetModelSetAsync(string id, string ownerAdminId);

    Task<ModelLabGroup> UpsertLabGroupAsync(ModelLabGroup group);
    Task<List<ModelLabGroup>> ListLabGroupsAsync(string ownerAdminId, string? search, int limit);
    Task<ModelLabGroup?> GetLabGroupAsync(string id, string ownerAdminId);
    Task<bool> DeleteLabGroupAsync(string id, string ownerAdminId);

    Task<ModelLabRun> InsertRunAsync(ModelLabRun run);
    Task UpdateRunAsync(ModelLabRun run);
    Task<ModelLabRun?> GetRunAsync(string id, string ownerAdminId);
    Task<List<ModelLabRun>> ListRunsByExperimentAsync(string ownerAdminId, string experimentId, int limit);

    Task<ModelLabRunItem> InsertRunItemAsync(ModelLabRunItem item);
    Task UpdateRunItemAsync(ModelLabRunItem item);
    Task<List<ModelLabRunItem>> ListRunItemsAsync(string ownerAdminId, string runId);
}


