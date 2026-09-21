using AgentToolsControlCenter.Services;
using AgentToolsControlCenter.Web;
using Microsoft.AspNetCore.Http;

var cases = new[]
{
    (Input: "token=abc", Forbidden: "abc", Required: "[redacted]"),
    (Input: "password=\"two words\"", Forbidden: "two words", Required: "[redacted]"),
    (Input: "Bearer topsecret", Forbidden: "topsecret", Required: "[redacted]"),
    (Input: "http://internal.example/a", Forbidden: "internal.example", Required: "[url]"),
    (Input: "user@example.com", Forbidden: "user@example.com", Required: "[email]"),
    (Input: @"\\server\share\file.txt", Forbidden: "server", Required: "[local path]"),
    (Input: "/home/example-user/private/file.txt", Forbidden: "/home/example-user", Required: "[local path]"),
    (Input: "PID 123", Forbidden: "PID 123", Required: "PID [hidden]"),
};

foreach (var item in cases)
{
    var sanitized = PublicTextSanitizer.Sanitize(item.Input);
    if (sanitized.Contains(item.Forbidden, StringComparison.OrdinalIgnoreCase))
    {
        Console.Error.WriteLine($"Sensitive public text was not sanitized: {item.Input} -> {sanitized}");
        return 1;
    }
    if (!sanitized.Contains(item.Required, StringComparison.Ordinal))
    {
        Console.Error.WriteLine($"Expected sanitizer marker missing: {item.Required}. Output: {sanitized}");
        return 2;
    }
}

var security = new TaskActionSecurity();
var localContext = new DefaultHttpContext();
localContext.Request.Host = new HostString("127.0.0.1", 47832);
localContext.Request.ContentType = "application/json";
if (security.ValidateActionRequest(localContext) is null)
{
    Console.Error.WriteLine("CSRF-less local task action was accepted.");
    return 3;
}
localContext.Request.Headers["X-Control-Center-CSRF"] = security.CsrfToken;
if (security.ValidateActionRequest(localContext) is not null)
{
    Console.Error.WriteLine("Valid local task action session was rejected.");
    return 4;
}

var remoteContext = new DefaultHttpContext();
remoteContext.Request.Host = new HostString("control.example.com");
remoteContext.Request.ContentType = "application/json";
remoteContext.Request.Headers["X-Control-Center-CSRF"] = security.CsrfToken;
if (security.ValidateActionRequest(remoteContext) is null)
{
    Console.Error.WriteLine("Remote task action without Cloudflare Access identity was accepted.");
    return 5;
}
remoteContext.Request.Headers["Cf-Access-Jwt-Assertion"] = "verified-upstream-fixture";
remoteContext.Request.Headers["Cf-Access-Authenticated-User-Email"] = "fixture@example.com";
if (security.ValidateActionRequest(remoteContext) is not null)
{
    Console.Error.WriteLine("Remote task action with Access identity and CSRF token was rejected.");
    return 6;
}

var publicInspection = PublicProjection.TaskInspection(new TaskInspectionResult(
    "task_fixture",
    "blocked",
    "paused",
    "token=secret-value",
    "待機",
    @"D:\\test-fixtures\\private.txt",
    DateTimeOffset.Now,
    DateTimeOffset.Now,
    "実装",
    "Bearer private-token",
    DateTimeOffset.Now,
    "waiting_host",
    "Control Center",
    "続行",
    "local_write",
    false,
    true,
    true,
    "active",
    "ws_private_should_not_be_projected",
    DateTimeOffset.Now,
    null,
    true,
    "main",
    2,
    "M relative-file.txt",
    "sensitive note"));
if (publicInspection.StateReason?.Contains("secret-value", StringComparison.Ordinal) == true
    || publicInspection.CurrentWork?.Contains("Users", StringComparison.OrdinalIgnoreCase) == true
    || publicInspection.LatestChatGptMessage?.Contains("private-token", StringComparison.Ordinal) == true)
{
    Console.Error.WriteLine("Public task inspection leaked sensitive text.");
    return 7;
}

var tempRoot = Path.Combine(Path.GetTempPath(), $"agenttools-control-update-test-{Guid.NewGuid():N}");
try
{
    var controlRoot = Path.Combine(tempRoot, "agenttools-control-center");
    var desktopDist = Path.Combine(controlRoot, "dist");
    var webDist = Path.Combine(controlRoot, "web", "dist");
    Directory.CreateDirectory(desktopDist);
    Directory.CreateDirectory(webDist);
    var sourceFile = Path.Combine(controlRoot, "MainWindow.xaml");
    var desktopExe = Path.Combine(desktopDist, "AgentToolsControlCenter.exe");
    var webExe = Path.Combine(webDist, "AgentToolsControlCenter.Web.exe");
    File.WriteAllText(sourceFile, "fixture");
    File.WriteAllText(desktopExe, "fixture");
    File.WriteAllText(webExe, "fixture");
    var baseline = DateTime.UtcNow.AddMinutes(-5);
    File.SetLastWriteTimeUtc(sourceFile, baseline);
    File.SetLastWriteTimeUtc(desktopExe, baseline.AddMinutes(1));
    File.SetLastWriteTimeUtc(webExe, baseline.AddMinutes(1));

    var updateService = new ControlCenterUpdateService(tempRoot);
    if (updateService.GetStatus().UpdateAvailable)
    {
        Console.Error.WriteLine("Control Center update detector reported a false positive.");
        return 8;
    }

    File.SetLastWriteTimeUtc(sourceFile, baseline.AddMinutes(2));
    if (!updateService.GetStatus().UpdateAvailable)
    {
        Console.Error.WriteLine("Control Center update detector missed a newer source file.");
        return 9;
    }

    if (updateService.RequestApplyAndRestart(false).Accepted)
    {
        Console.Error.WriteLine("Control Center restart accepted a request without explicit confirmation.");
        return 10;
    }
}
finally
{
    try { Directory.Delete(tempRoot, recursive: true); } catch { }
}

Console.WriteLine("public sanitizer, task-action security, and control-update tests passed");
return 0;
