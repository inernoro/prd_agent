using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class HostedShareCookieTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("grant:synthetic")]
    public void OptionalPasswordOmittedFromQuery_StillReceivesShareCookie(string? credential)
    {
        var http = new DefaultHttpContext();
        if (credential != null)
            http.Request.Headers.Cookie = HostedShareGrant.CookieName("one") + "=" + credential;
        var routes = new RouteData(); routes.Values["token"] = "one";
        var descriptor = new ActionDescriptor
        {
            Parameters = new List<ParameterDescriptor>
            {
                new() { Name = "password", ParameterType = typeof(string) }
            }
        };
        descriptor.RouteValues["action"] = "ViewShare";
        // MVC omits an unbound optional query parameter from ActionArguments.
        var arguments = new Dictionary<string, object?>();
        var context = new ActionExecutingContext(new ActionContext(http, routes, descriptor),
            new List<IFilterMetadata>(), arguments, new object());
        new HostedShareCookieAttribute().OnActionExecuting(context);
        Assert.True(arguments.ContainsKey("password"));
        Assert.Equal(credential, arguments["password"]);
    }

    [Theory]
    [InlineData("ViewShare")]
    [InlineData("GetShareSiteContent")]
    [InlineData("ExportSharedSite")]
    [InlineData("DownloadSharedPdf")]
    [InlineData("ListShareComments")]
    [InlineData("AskByShare")]
    public void AccessUsesShareCookieInsteadOfQueryOrRepeatedBodyPassword(string action)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers.Cookie = HostedShareGrant.CookieName("one") + "=grant:synthetic";
        http.Request.QueryString = new QueryString("?password=synthetic-secret");
        var routes = new RouteData(); routes.Values["token"] = "one";
        var descriptor = new ActionDescriptor(); descriptor.RouteValues["action"] = action;
        var request = new WebPagesController.UnlockShareRequest { Password = "synthetic-secret" };
        var arguments = new Dictionary<string, object?> { ["password"] = "synthetic-secret", ["req"] = request };
        var context = new ActionExecutingContext(new ActionContext(http, routes, descriptor), new List<IFilterMetadata>(), arguments, new object());
        new HostedShareCookieAttribute().OnActionExecuting(context);
        Assert.Equal("grant:synthetic", arguments["password"]);
        Assert.Equal("grant:synthetic", request.Password);
        Assert.Equal("no-store", http.Response.Headers.CacheControl.ToString());
        routes.Values["token"] = "other";
        new HostedShareCookieAttribute().OnActionExecuting(context);
        Assert.Null(arguments["password"]);
        Assert.Null(request.Password);
    }

    [Theory]
    [InlineData(typeof(WebPagesController))]
    [InlineData(typeof(WebPageAskController))]
    [InlineData(typeof(HostedSiteExportController))]
    [InlineData(typeof(HostedSitePdfDownloadController))]
    public void AllHostedShareControllerFamiliesApplyCookieGate(Type controller) =>
        Assert.NotEmpty(controller.GetCustomAttributes(typeof(HostedShareCookieAttribute), true));
}
