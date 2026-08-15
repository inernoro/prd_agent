using PrdAgent.Infrastructure.LlmGateway.Asr;

namespace PrdAgent.Api.Services;

internal static class AsrAudioRoutePolicy
{
    public static bool ShouldUseChatAudio(string? model, string? protocol, string? platformType)
        => AsrRequestContractPolicy.ShouldUseChatAudio(model, protocol, platformType);
}
