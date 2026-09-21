using System.Net;
using System.Security.Cryptography;
using AgentToolsControlCenter.Services;
using AgentToolsControlCenter.Web;

var builder = WebApplication.CreateBuilder(args);
const int CommunicationDisplayLimit = 20;
const int TaskCommunicationDisplayLimit = 10;

var port = 47832;
var configuredPort = Environment.GetEnvironmentVariable("CONTROL_CENTER_WEB_PORT");
if (!string.IsNullOrWhiteSpace(configuredPort) && (!int.TryParse(configuredPort, out port) || port is < 1024 or > 65535))
{
    throw new InvalidOperationException("CONTROL_CENTER_WEB_PORT must be an integer between 1024 and 65535.");
}

// Keep the origin loopback-only at Kestrel level. Cloudflare Tunnel runs on the
// same machine and does not require a LAN/public bind or router port forwarding.
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, port));
builder.Services.AddSingleton<StatusCollector>();
builder.Services.AddSingleton(sp => new ActivityCollector(sp.GetRequiredService<StatusCollector>().AgentToolsRoot));
builder.Services.AddSingleton(sp => new SkillImprovementCollector(sp.GetRequiredService<StatusCollector>().AgentToolsRoot));
builder.Services.AddSingleton(sp => new TaskControlService(sp.GetRequiredService<StatusCollector>().AgentToolsRoot));
builder.Services.AddSingleton(sp => new HostRequestService(sp.GetRequiredService<StatusCollector>().AgentToolsRoot));
builder.Services.AddSingleton(sp => new ControlCenterUpdateService(sp.GetRequiredService<StatusCollector>().AgentToolsRoot, port));
builder.Services.AddSingleton<TaskActionSecurity>();
builder.Services.AddSingleton<DashboardSnapshotCache>();
builder.Services.AddSingleton<SystemResourceCollector>();
builder.Services.AddSingleton<PlanUsageCollector>();

var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers["Cache-Control"] = "no-store";
    context.Response.Headers["Pragma"] = "no-cache";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/healthz", () => Results.Json(new
{
    ok = true,
    service = "AgentTools Control Center Web",
    bind = "loopback-only"
}));

app.MapGet("/api/services", async (DashboardSnapshotCache cache, CancellationToken cancellationToken) =>
{
    var snapshot = await cache.GetServicesAsync(cancellationToken);
    return Results.Json(snapshot);
});

app.MapGet("/api/tasks", async (DashboardSnapshotCache cache, CancellationToken cancellationToken) =>
{
    var snapshot = await cache.GetTasksAsync(cancellationToken);
    return Results.Json(snapshot);
});

// Compatibility endpoint for older Control Center clients.
app.MapGet("/api/activities", async (DashboardSnapshotCache cache, CancellationToken cancellationToken) =>
{
    var snapshot = await cache.GetTasksAsync(cancellationToken);
    return Results.Json(snapshot);
});

app.MapGet("/api/task-actions/session", (HttpContext context, TaskActionSecurity security) =>
{
    if (!security.IsAuthorized(context)) return Results.StatusCode(StatusCodes.Status403Forbidden);
    return Results.Json(new { csrfToken = security.CsrfToken, enabled = true });
});

app.MapPost("/api/tasks/{id}/inspect", async (string id, HttpContext context, TaskActionSecurity security, TaskControlService taskControl, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    try
    {
        var inspection = await taskControl.InspectAsync(id, cancellationToken);
        return Results.Json(new { ok = true, inspection = PublicProjection.TaskInspection(inspection) });
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.MapPost("/api/tasks/{id}/inspect-detailed", async (string id, HttpContext context, TaskActionSecurity security, HostRequestService hostRequests, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    try
    {
        var result = await hostRequests.EnqueueDetailedInspectionAsync(id, cancellationToken);
        return Results.Json(new
        {
            ok = result.Succeeded,
            duplicate = result.Duplicate,
            request = result.Request is null ? null : PublicProjection.HostRequest(result.Request),
            message = PublicTextSanitizer.Sanitize(result.Message)
        }, statusCode: result.Succeeded ? StatusCodes.Status202Accepted : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.MapPost("/api/tasks/{id}/continue-chatgpt", async (string id, HttpContext context, TaskActionSecurity security, HostRequestService hostRequests, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    try
    {
        var result = await hostRequests.EnqueueTaskContinuationAsync(id, cancellationToken);
        return Results.Json(new
        {
            ok = result.Succeeded,
            duplicate = result.Duplicate,
            request = result.Request is null ? null : PublicProjection.HostRequest(result.Request),
            message = PublicTextSanitizer.Sanitize(result.Message)
        }, statusCode: result.Succeeded ? StatusCodes.Status202Accepted : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.MapGet("/api/communications", async (HostRequestService hostRequests, CancellationToken cancellationToken) =>
{
    try
    {
        var requests = await hostRequests.ListAsync(CommunicationDisplayLimit, cancellationToken: cancellationToken);
        return Results.Json(new
        {
            refreshedAt = DateTimeOffset.Now,
            limit = CommunicationDisplayLimit,
            requests = requests.Select(PublicProjection.HostRequest).ToArray()
        });
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new
        {
            refreshedAt = DateTimeOffset.Now,
            limit = CommunicationDisplayLimit,
            error = PublicProjection.SafeError(ex),
            requests = Array.Empty<PublicHostRequest>()
        });
    }
});

app.MapGet("/api/tasks/{id}/communications", async (string id, HostRequestService hostRequests, CancellationToken cancellationToken) =>
{
    try
    {
        var requests = await hostRequests.ListAsync(TaskCommunicationDisplayLimit, id, cancellationToken);
        return Results.Json(new
        {
            refreshedAt = DateTimeOffset.Now,
            taskId = id,
            limit = TaskCommunicationDisplayLimit,
            requests = requests.Select(PublicProjection.HostRequest).ToArray()
        });
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new
        {
            refreshedAt = DateTimeOffset.Now,
            taskId = id,
            limit = TaskCommunicationDisplayLimit,
            error = PublicProjection.SafeError(ex),
            requests = Array.Empty<PublicHostRequest>()
        }, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.MapGet("/api/communications/{id}", async (string id, HostRequestService hostRequests, CancellationToken cancellationToken) =>
{
    try
    {
        var detail = await hostRequests.GetAsync(id, cancellationToken);
        return Results.Json(new { ok = true, detail = PublicProjection.HostRequestDetail(detail) });
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status404NotFound);
    }
});

app.MapPost("/api/tasks/{id}/resume-prompt", async (string id, HttpContext context, TaskActionSecurity security, TaskControlService taskControl, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    try
    {
        var result = await taskControl.GetResumePromptAsync(id, cancellationToken);
        return Results.Json(new
        {
            ok = result.Succeeded,
            action = PublicTextSanitizer.Sanitize(result.Action),
            prompt = PublicTextSanitizer.Sanitize(result.Prompt),
            message = PublicTextSanitizer.Sanitize(result.Message)
        }, statusCode: result.Succeeded ? StatusCodes.Status200OK : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status400BadRequest);
    }
});

// Compatibility endpoint for older Web clients. It no longer starts Codex automatically.
app.MapPost("/api/tasks/{id}/continue", async (string id, HttpContext context, TaskActionSecurity security, TaskControlService taskControl, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    try
    {
        var result = await taskControl.GetResumePromptAsync(id, cancellationToken);
        return Results.Json(new
        {
            ok = result.Succeeded,
            action = PublicTextSanitizer.Sanitize(result.Action),
            prompt = PublicTextSanitizer.Sanitize(result.Prompt),
            message = "旧クライアント互換endpointです。通常のWeb UIでは「作業続行」からChatGPT Host Request Queueへ登録してください。"
        }, statusCode: result.Succeeded ? StatusCodes.Status200OK : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.MapPost("/api/tasks/{id}/continue-codex", async (string id, HttpContext context, TaskActionSecurity security, TaskControlService taskControl, DashboardSnapshotCache cache, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    try
    {
        var result = await taskControl.ContinueWithCodexAsync(id, cancellationToken);
        cache.InvalidateTasks();
        return Results.Json(new
        {
            ok = result.Succeeded,
            action = PublicTextSanitizer.Sanitize(result.Action),
            message = PublicTextSanitizer.Sanitize(result.Message)
        }, statusCode: result.Succeeded ? StatusCodes.Status200OK : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status400BadRequest);
    }
});

app.MapPost("/api/tasks/{id}/complete", async (string id, TaskActionRequest request, HttpContext context, TaskActionSecurity security, TaskControlService taskControl, DashboardSnapshotCache cache, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    if (!request.Confirm || !DateTime.TryParse(request.ExpectedUpdatedAt, out var expectedUpdatedAt))
    {
        return Results.Json(new { ok = false, error = "タスク終了には最新状態に対する明示確認が必要です。" }, statusCode: StatusCodes.Status400BadRequest);
    }
    try
    {
        var result = await taskControl.CompleteForgottenAsync(id, expectedUpdatedAt, cancellationToken);
        cache.InvalidateTasks();
        return Results.Json(new
        {
            ok = result.Succeeded,
            action = PublicTextSanitizer.Sanitize(result.Action),
            message = PublicTextSanitizer.Sanitize(result.Message)
        }, statusCode: result.Succeeded ? StatusCodes.Status200OK : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status409Conflict);
    }
});

app.MapGet("/api/control-center/update-status", (HttpContext context, TaskActionSecurity security, ControlCenterUpdateService updateService) =>
{
    if (!security.IsAuthorized(context)) return Results.StatusCode(StatusCodes.Status403Forbidden);
    return Results.Json(updateService.GetStatus());
});

app.MapPost("/api/control-center/apply-update", (ControlCenterRestartRequest request, HttpContext context, TaskActionSecurity security, ControlCenterUpdateService updateService) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    if (!request.Confirm)
    {
        return Results.Json(new { ok = false, error = "更新反映と再起動には明示確認が必要です。" }, statusCode: StatusCodes.Status400BadRequest);
    }

    var result = updateService.RequestApplyAndRestart(request.Confirm);
    return Results.Json(new
    {
        ok = result.Accepted,
        message = result.Message
    }, statusCode: result.Accepted ? StatusCodes.Status202Accepted : StatusCodes.Status409Conflict);
});

app.MapPost("/api/devspace/restart", async (DevSpaceRestartRequest request, HttpContext context, TaskActionSecurity security, StatusCollector collector, DashboardSnapshotCache cache, CancellationToken cancellationToken) =>
{
    var rejection = security.ValidateActionRequest(context);
    if (rejection is not null) return rejection;
    if (!request.Confirm)
    {
        return Results.Json(new { ok = false, error = "DevSpace再起動には明示確認が必要です。" }, statusCode: StatusCodes.Status400BadRequest);
    }

    try
    {
        var result = await collector.RestartAsync("devspace", cancellationToken);
        cache.InvalidateServices();
        var message = result.Succeeded
            ? "DevSpaceの安全な再起動を完了しました。"
            : result.TimedOut
                ? "DevSpace再起動がタイムアウトしました。"
                : string.IsNullOrWhiteSpace(result.StandardError) ? result.StandardOutput : result.StandardError;
        return Results.Json(new
        {
            ok = result.Succeeded,
            message = PublicTextSanitizer.Sanitize(message)
        }, statusCode: result.Succeeded ? StatusCodes.Status200OK : StatusCodes.Status409Conflict);
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { ok = false, error = PublicProjection.SafeActionError(ex) }, statusCode: StatusCodes.Status409Conflict);
    }
});

app.MapGet("/api/resources", async (SystemResourceCollector collector, CancellationToken cancellationToken) =>
{
    var snapshot = await collector.CollectAsync(cancellationToken);
    return Results.Json(snapshot);
});

app.MapGet("/api/plan-usage", async (PlanUsageCollector collector, CancellationToken cancellationToken) =>
{
    var snapshot = await collector.CollectAsync(cancellationToken: cancellationToken);
    return Results.Json(snapshot);
});

app.MapGet("/api/skill-improvements", async (SkillImprovementCollector service, CancellationToken cancellationToken) =>
{
    try
    {
        var proposals = await service.CollectAsync(cancellationToken);
        return Results.Json(new
        {
            refreshedAt = DateTimeOffset.Now,
            error = (string?)null,
            proposals = proposals.Select(PublicProjection.SkillImprovement).ToArray()
        });
    }
    catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new
        {
            refreshedAt = DateTimeOffset.Now,
            error = PublicProjection.SafeError(ex),
            proposals = Array.Empty<PublicSkillImprovement>()
        });
    }
});

app.MapFallbackToFile("index.html");

await app.RunAsync();

public sealed record TaskActionRequest(bool Confirm, string? ExpectedUpdatedAt);
public sealed record ControlCenterRestartRequest(bool Confirm);
public sealed record DevSpaceRestartRequest(bool Confirm);

public sealed class TaskActionSecurity
{
    private readonly byte[] _csrfBytes = RandomNumberGenerator.GetBytes(32);
    public string CsrfToken => Convert.ToBase64String(_csrfBytes);

    public bool IsAuthorized(HttpContext context)
    {
        var host = context.Request.Host.Host;
        var localHost = string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase);
        if (localHost) return true;

        // cloudflared validates the Access JWT before forwarding when
        // originRequest.access.required=true. The app additionally refuses
        // remote write sessions if the verified Access identity headers are absent.
        return !string.IsNullOrWhiteSpace(context.Request.Headers["Cf-Access-Jwt-Assertion"].ToString())
            && !string.IsNullOrWhiteSpace(context.Request.Headers["Cf-Access-Authenticated-User-Email"].ToString());
    }

    public IResult? ValidateActionRequest(HttpContext context)
    {
        if (!IsAuthorized(context)) return Results.StatusCode(StatusCodes.Status403Forbidden);
        if (!context.Request.HasJsonContentType()) return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);

        var fetchSite = context.Request.Headers["Sec-Fetch-Site"].ToString();
        if (!string.IsNullOrWhiteSpace(fetchSite) && !string.Equals(fetchSite, "same-origin", StringComparison.OrdinalIgnoreCase))
            return Results.StatusCode(StatusCodes.Status403Forbidden);

        var supplied = context.Request.Headers["X-Control-Center-CSRF"].ToString();
        byte[] suppliedBytes;
        try { suppliedBytes = Convert.FromBase64String(supplied); }
        catch { return Results.StatusCode(StatusCodes.Status403Forbidden); }
        if (suppliedBytes.Length != _csrfBytes.Length || !CryptographicOperations.FixedTimeEquals(suppliedBytes, _csrfBytes))
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        return null;
    }
}
