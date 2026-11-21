using Moq;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Filters;
using System.Security.Claims;

[Xunit.Collection("DevelopmentSecurity")]
public sealed class DevelopmentSecurityGateTests
{
[Xunit.Fact]
public async Task GatesEnforceEnvironmentCredentialsAndCurrentGrants()
{
foreach(var (environment, enabled, credential, expected) in new[]{("Production",true,true,404),("Development",false,true,404),("Development",true,false,401),("Development",true,true,200)})
{
 var http = new DefaultHttpContext();
 if(credential) http.Request.Headers.Authorization="Bearer "+new string('x',32);
 var action = new ActionContext(http,new RouteData(),new ActionDescriptor());
 var ctx = new ResourceExecutingContext(action,new List<IFilterMetadata>(),new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
 var filter = new DevelopmentStubFilter(new Env{EnvironmentName=environment},new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>{{"DevelopmentStub:Enabled",enabled.ToString()},{"DevelopmentStub:ApiKey",new string('x',32)}}).Build());
 var ran=false;
 await filter.OnResourceExecutionAsync(ctx,()=>{ran=true;return Task.FromResult(new ResourceExecutedContext(action,new List<IFilterMetadata>()));});
 var status=ran?200:((StatusCodeResult)ctx.Result!).StatusCode;
 if(status!=expected) throw new Exception($"Expected {expected}, got {status}");
 Console.WriteLine($"Stub {environment} enabled={enabled} credential={credential}: {status}");
}
foreach(var (authenticated, grant, apiKey, expected) in new[]{(false,false,false,401),(true,false,false,403),(true,true,false,200),(true,true,true,403)})
{
 var http=new DefaultHttpContext();
 if(authenticated) http.User=new ClaimsPrincipal(new ClaimsIdentity(new[]{new Claim("sub","user")}.Concat(apiKey?new[]{new Claim("authType","agent-apikey")}:Array.Empty<Claim>()),"test"));
 var ctx=new AuthorizationFilterContext(new ActionContext(http,new RouteData(),new ActionDescriptor()),new List<IFilterMetadata>());
 await new ResolverDiagnosticsFilter(CreatePermissions(grant),NullLogger<ResolverDiagnosticsFilter>.Instance).OnAuthorizationAsync(ctx);
 var status=ctx.Result==null?200:((StatusCodeResult)ctx.Result).StatusCode;
 if(status!=expected)throw new Exception($"Expected {expected}, got {status}");
 Console.WriteLine($"Resolver authenticated={authenticated} grants={grant} apiKey={apiKey}: {status}");
}
 }
[Xunit.Fact]
public async Task ConcurrencyBudgetRejectsThirdAndReleasesAfterCompletion()
{
 var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>
 { ["DevelopmentStub:Enabled"]="true", ["DevelopmentStub:ApiKey"]=new string('x',32) }).Build();
 var filter = new DevelopmentStubFilter(new Env { EnvironmentName="Development" }, config);
 ResourceExecutingContext Context()
 {
  var http = new DefaultHttpContext(); http.Request.Headers.Authorization="Bearer "+new string('x',32);
  return new ResourceExecutingContext(new ActionContext(http,new RouteData(),new ActionDescriptor()),new List<IFilterMetadata>(),new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
 }
 var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
 var first=Context(); var second=Context(); var third=Context();
 async Task<ResourceExecutedContext> Hold(ResourceExecutingContext ctx)
 { await release.Task; return new ResourceExecutedContext(ctx,new List<IFilterMetadata>()); }
 var a=filter.OnResourceExecutionAsync(first,()=>Hold(first));
 var b=filter.OnResourceExecutionAsync(second,()=>Hold(second));
 try
 {
  await filter.OnResourceExecutionAsync(third,()=>throw new Exception("Third request must not execute"));
  Xunit.Assert.Equal(429, ((StatusCodeResult)third.Result!).StatusCode);
 }
 finally { release.TrySetResult(true); await Task.WhenAll(a,b); }
 var after=Context(); var ran=false;
 await filter.OnResourceExecutionAsync(after,()=>{ran=true;return Task.FromResult(new ResourceExecutedContext(after,new List<IFilterMetadata>()));});
 Xunit.Assert.True(ran);
}
private static PrdAgent.Core.Interfaces.IAdminPermissionService CreatePermissions(bool granted)
{
 var mock = new Moq.Mock<PrdAgent.Core.Interfaces.IAdminPermissionService>();
 mock.Setup(x => x.GetEffectivePermissionsAsync(Moq.It.IsAny<string>(), Moq.It.IsAny<bool>(), Moq.It.IsAny<CancellationToken>()))
 .ReturnsAsync((IReadOnlyList<string>)(granted ? new[]{"access", "mds.read"} : Array.Empty<string>()));
 return mock.Object;
}
class Env:IHostEnvironment {public string EnvironmentName{get;set;}="";public string ApplicationName{get;set;}="";public string ContentRootPath{get;set;}="";public IFileProvider ContentRootFileProvider{get;set;}=new NullFileProvider();}
}
