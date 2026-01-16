using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

public class PutWatermarkRequest
{
    public bool? Enabled { get; set; }

    public string? ActiveSpecId { get; set; }

    public List<WatermarkSpec>? Specs { get; set; }

    public WatermarkSpec? Spec { get; set; }
}
