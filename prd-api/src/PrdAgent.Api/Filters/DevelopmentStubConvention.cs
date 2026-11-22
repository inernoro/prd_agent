using Microsoft.AspNetCore.Mvc.ApplicationModels;
using PrdAgent.Api.Controllers.Stub;

namespace PrdAgent.Api.Filters;

public sealed class DevelopmentStubConvention(bool enabled) : IApplicationModelConvention
{
    public void Apply(ApplicationModel application)
    {
        if (enabled) return;
        foreach (var controller in application.Controllers.Where(c => c.ControllerType.AsType() == typeof(StubOpenAIController)).ToList())
            application.Controllers.Remove(controller);
    }
}
