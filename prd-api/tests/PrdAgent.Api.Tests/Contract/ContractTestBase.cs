using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Contract;

/// <summary>
/// Contract test base class - provides utilities for API contract validation
///
/// Contract tests verify:
/// 1. Request format matches what frontend sends
/// 2. Response format matches what frontend expects
/// 3. Field naming (camelCase) is consistent
/// 4. Required fields are present
/// 5. Nullable fields are handled correctly
/// </summary>
[Trait("Category", "Contract")]
public abstract class ContractTestBase
{
    protected readonly ITestOutputHelper Output;

    protected static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    protected ContractTestBase(ITestOutputHelper output)
    {
        Output = output;
    }

    /// <summary>
    /// Log a test step with formatting
    /// </summary>
    protected void Log(string message)
    {
        Output.WriteLine(message);
    }

    /// <summary>
    /// Log a section header
    /// </summary>
    protected void LogSection(string title)
    {
        Output.WriteLine("\n" + new string('=', 60));
        Output.WriteLine($"  {title}");
        Output.WriteLine(new string('=', 60));
    }

    /// <summary>
    /// Log JSON with formatting
    /// </summary>
    protected void LogJson(string label, object obj)
    {
        Output.WriteLine($"\n[{label}]");
        Output.WriteLine(new string('-', 40));
        Output.WriteLine(JsonSerializer.Serialize(obj, JsonOptions));
        Output.WriteLine(new string('-', 40));
    }

    /// <summary>
    /// Verify a JSON string can be deserialized to type T
    /// </summary>
    protected T AssertDeserializes<T>(string json) where T : class
    {
        var result = JsonSerializer.Deserialize<T>(json, JsonOptions);
        Assert.NotNull(result);
        return result;
    }

    /// <summary>
    /// Verify JSON has required fields
    /// </summary>
    protected void AssertJsonHasFields(string json, params string[] fieldNames)
    {
        var doc = JsonDocument.Parse(json);
        foreach (var field in fieldNames)
        {
            Assert.True(
                doc.RootElement.TryGetProperty(field, out _),
                $"Missing required field: {field}"
            );
        }
    }

    /// <summary>
    /// Verify serialization roundtrip preserves data
    /// </summary>
    protected void AssertRoundtrip<T>(T original) where T : class
    {
        var json = JsonSerializer.Serialize(original, JsonOptions);
        var deserialized = JsonSerializer.Deserialize<T>(json, JsonOptions);
        var jsonAgain = JsonSerializer.Serialize(deserialized, JsonOptions);
        Assert.Equal(json, jsonAgain);
    }
}
