using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Interfaces;

public enum ModelPurpose
{
    MainChat = 0,
    Intent = 1,
    Vision = 2,
    ImageGen = 3
}

public interface IModelDomainService
{
    Task<ILLMClient> GetClientAsync(ModelPurpose purpose, CancellationToken ct = default);
    Task<string> SuggestGroupNameAsync(string? fileName, string snippet, CancellationToken ct = default);
}


