using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

public class PutWatermarkRequest
{
    public WatermarkSpec? Spec { get; set; }
}
