using MongoDB.Bson;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.AppCallers;

internal static class SystemIntentDraftCaller
{
    public const string Code = "llmgw-console.intent-draft::chat";
    public const string SourceSystem = "llmgw-console";
    public const string Title = "Quickstart 用途推导";

    public static bool OwnsRegistration(BsonDocument caller) =>
        caller.AsNullableBool("SystemManaged") == true
        || (!caller.Contains("SystemManaged") && caller.AsNullableString("SourceSystem") == SourceSystem);

    public static string? ReadTitle(BsonDocument caller)
    {
        var title = caller.AsNullableString("Title");
        if (!string.Equals(caller.AsNullableString("AppCallerCode"), Code, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(caller.AsNullableString("RequestType"), "chat", StringComparison.OrdinalIgnoreCase)
            || !OwnsRegistration(caller))
            return title;

        return string.IsNullOrWhiteSpace(title) || string.Equals(title.Trim(), Code, StringComparison.OrdinalIgnoreCase)
            ? Title : title;
    }
}
