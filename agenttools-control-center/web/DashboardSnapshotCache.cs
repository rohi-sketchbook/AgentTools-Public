using System.Text.RegularExpressions;
using AgentToolsControlCenter.Models;
using AgentToolsControlCenter.Services;

namespace AgentToolsControlCenter.Web;

public sealed class DashboardSnapshotCache
{
    private static readonly TimeSpan ServiceCacheDuration = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan TaskCacheDuration = TimeSpan.FromSeconds(2);

    private readonly StatusCollector _statusCollector;
    private readonly ActivityCollector _taskCollector;
    private readonly SemaphoreSlim _serviceGate = new(1, 1);
    private readonly SemaphoreSlim _taskGate = new(1, 1);

    private ServiceSnapshot? _serviceSnapshot;
    private TaskSnapshot? _taskSnapshot;

    public DashboardSnapshotCache(StatusCollector statusCollector, ActivityCollector taskCollector)
    {
        _statusCollector = statusCollector;
        _taskCollector = taskCollector;
    }

    public async Task<ServiceSnapshot> GetServicesAsync(CancellationToken cancellationToken)
    {
        var current = _serviceSnapshot;
        if (current is not null && DateTimeOffset.Now - current.RefreshedAt < ServiceCacheDuration)
        {
            return current;
        }

        await _serviceGate.WaitAsync(cancellationToken);
        try
        {
            current = _serviceSnapshot;
            if (current is not null && DateTimeOffset.Now - current.RefreshedAt < ServiceCacheDuration)
            {
                return current;
            }

            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(45));
                var statuses = await _statusCollector.CollectAsync(timeout.Token);
                var snapshot = new ServiceSnapshot(
                    DateTimeOffset.Now,
                    false,
                    null,
                    statuses.Select(PublicProjection.Service).ToArray());
                _serviceSnapshot = snapshot;
                return snapshot;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                var failed = current is not null
                    ? current with
                    {
                        RefreshedAt = DateTimeOffset.Now,
                        Stale = true,
                        Error = "状態の再取得に失敗しました。直前の情報を表示しています。"
                    }
                    : new ServiceSnapshot(DateTimeOffset.Now, true, PublicProjection.SafeError(ex), []);
                _serviceSnapshot = failed;
                return failed;
            }
        }
        finally
        {
            _serviceGate.Release();
        }
    }

    public void InvalidateServices() => _serviceSnapshot = null;

    public void InvalidateTasks() => _taskSnapshot = null;

    public async Task<TaskSnapshot> GetTasksAsync(CancellationToken cancellationToken)
    {
        var current = _taskSnapshot;
        if (current is not null && DateTimeOffset.Now - current.RefreshedAt < TaskCacheDuration)
        {
            return current;
        }

        await _taskGate.WaitAsync(cancellationToken);
        try
        {
            current = _taskSnapshot;
            if (current is not null && DateTimeOffset.Now - current.RefreshedAt < TaskCacheDuration)
            {
                return current;
            }

            try
            {
                var tasks = await _taskCollector.CollectAsync(cancellationToken);
                var snapshot = new TaskSnapshot(
                    DateTimeOffset.Now,
                    false,
                    null,
                    tasks.Select(PublicProjection.Task).ToArray());
                _taskSnapshot = snapshot;
                return snapshot;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                var failed = current is not null
                    ? current with
                    {
                        RefreshedAt = DateTimeOffset.Now,
                        Stale = true,
                        Error = "タスクの再取得に失敗しました。直前の情報を表示しています。"
                    }
                    : new TaskSnapshot(DateTimeOffset.Now, true, PublicProjection.SafeError(ex), []);
                _taskSnapshot = failed;
                return failed;
            }
        }
        finally
        {
            _taskGate.Release();
        }
    }
}

public sealed record ServiceSnapshot(
    DateTimeOffset RefreshedAt,
    bool Stale,
    string? Error,
    IReadOnlyList<PublicServiceStatus> Services);

public sealed record TaskSnapshot(
    DateTimeOffset RefreshedAt,
    bool Stale,
    string? Error,
    IReadOnlyList<PublicWorkTask> Tasks);

public sealed record PublicServiceStatus(
    string Id,
    string DisplayName,
    string Health,
    string StatusText,
    string Summary,
    DateTimeOffset CheckedAt,
    string StatusColor);

public sealed record PublicWorkTask(
    string Id,
    string Title,
    string Status,
    string StatusText,
    string StatusColor,
    string? Phase,
    string? CurrentWork,
    string? State,
    string? StateReason,
    string? Project,
    string? ContinuationStatus,
    string? ContinuationModel,
    int ContinuationAttempt,
    bool ContinuationSessionReused,
    int ContinuationSessionReuseCount,
    double? ContinuationUsedPercent,
    double? ContinuationRemainingPercent,
    string OwnerDisplay,
    string ContributorsDisplay,
    DateTime StartedAt,
    DateTime UpdatedAt);

public sealed record PublicTaskInspection(
    string TaskId,
    string? Status,
    string? State,
    string? StateReason,
    string? Phase,
    string? CurrentWork,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? LatestChatGptAt,
    string? LatestChatGptPhase,
    string? LatestChatGptMessage,
    DateTimeOffset? ContinueRequestedAt,
    string? ContinueRequestStatus,
    string? ContinueRequestedBy,
    string? ResumeNextStep,
    string? ResumeImpact,
    bool ResumeRequiresUserConfirmation,
    bool DevSpaceFound,
    bool DevSpaceReusable,
    string? DevSpaceStatus,
    DateTimeOffset? DevSpaceLastUsedAt,
    bool GitAvailable,
    string? GitBranch,
    int GitChangeCount,
    string Note);

public sealed record PublicHostRequest(
    string RequestId,
    string Type,
    string Status,
    string TaskId,
    string TaskTitle,
    string? ResultSummary,
    string? Failure,
    DateTimeOffset? CreatedAt,
    DateTimeOffset? UpdatedAt,
    DateTimeOffset? ClaimedAt,
    DateTimeOffset? CompletedAt,
    int ReportCharCount,
    int ReportHeadingCount);

public sealed record PublicHostRequestDetail(
    PublicHostRequest Request,
    string? ReportContent);

public sealed record PublicSkillImprovement(
    string Id,
    string SkillName,
    string Status,
    string StatusText,
    string StatusColor,
    string Summary,
    string Reason,
    string Source,
    string ProposedBy,
    string Diff,
    string? StaleReason,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public static class PublicTextSanitizer
{
    private static readonly Regex SensitiveAssignmentRegex = new(
        @"(?i)\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|cookie)\b\s*[:=]\s*(?:""[^""]*""|'[^']*'|[^\s,;]+)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex BearerTokenRegex = new(
        @"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex WindowsPathRegex = new(
        @"(?i)\b[A-Z]:(?:\\|/)[^\r\n]*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex UncPathRegex = new(
        @"\\\\[^\\\s\r\n]+\\[^\r\n]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex UnixPathRegex = new(
        @"(?<![\w:])/(?:home|Users|mnt|tmp|var|opt|srv|etc|root)/[^\s\r\n]*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    private static readonly Regex LocalEndpointRegex = new(
        @"(?i)(?:https?://)?(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:/[^\s]*)?",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex UrlRegex = new(
        @"(?i)\bhttps?://[^\s<>""']+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex EmailRegex = new(
        @"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex PidRegex = new(
        @"(?i)\bPID\s+\d+\b",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static string Sanitize(string value)
    {
        var sanitized = SensitiveAssignmentRegex.Replace(value, "$1=[redacted]");
        sanitized = BearerTokenRegex.Replace(sanitized, "Bearer [redacted]");
        sanitized = WindowsPathRegex.Replace(sanitized, "[local path]");
        sanitized = UncPathRegex.Replace(sanitized, "[local path]");
        sanitized = UnixPathRegex.Replace(sanitized, "[local path]");
        sanitized = LocalEndpointRegex.Replace(sanitized, "[local endpoint]");
        sanitized = UrlRegex.Replace(sanitized, "[url]");
        sanitized = EmailRegex.Replace(sanitized, "[email]");
        sanitized = PidRegex.Replace(sanitized, "PID [hidden]");
        return sanitized;
    }
}

public static class PublicProjection
{
    public static PublicServiceStatus Service(ServiceStatus service) => new(
        service.Id,
        service.DisplayName,
        service.Health.ToString().ToLowerInvariant(),
        service.StatusText,
        Sanitize(service.Summary),
        service.CheckedAt,
        service.StatusColor);

    public static PublicWorkTask Task(WorkActivity task) => new(
        task.Id,
        Sanitize(task.Title),
        task.Status,
        task.StatusText,
        task.StatusColor,
        SanitizeNullable(task.Phase),
        SanitizeNullable(task.CurrentWork),
        SanitizeNullable(task.State),
        SanitizeNullable(task.StateReason),
        SanitizeNullable(task.Project),
        SanitizeNullable(task.ContinuationStatus),
        SanitizeNullable(task.ContinuationModel),
        task.ContinuationAttempt,
        task.ContinuationSessionReused,
        task.ContinuationSessionReuseCount,
        task.ContinuationUsedPercent,
        task.ContinuationRemainingPercent,
        Sanitize(task.OwnerDisplay),
        Sanitize(task.ContributorsDisplay),
        task.StartedAt,
        task.UpdatedAt);

    public static PublicTaskInspection TaskInspection(TaskInspectionResult inspection) => new(
        inspection.TaskId,
        SanitizeNullable(inspection.Status),
        SanitizeNullable(inspection.State),
        SanitizeNullable(inspection.StateReason),
        SanitizeNullable(inspection.Phase),
        SanitizeNullable(inspection.CurrentWork),
        inspection.UpdatedAt,
        inspection.LatestChatGptAt,
        SanitizeNullable(inspection.LatestChatGptPhase),
        SanitizeNullable(inspection.LatestChatGptMessage),
        inspection.ContinueRequestedAt,
        SanitizeNullable(inspection.ContinueRequestStatus),
        SanitizeNullable(inspection.ContinueRequestedBy),
        SanitizeNullable(inspection.ResumeNextStep),
        SanitizeNullable(inspection.ResumeImpact),
        inspection.ResumeRequiresUserConfirmation,
        inspection.DevSpaceFound,
        inspection.DevSpaceReusable,
        SanitizeNullable(inspection.DevSpaceStatus),
        inspection.DevSpaceLastUsedAt,
        inspection.GitAvailable,
        SanitizeNullable(inspection.GitBranch),
        inspection.GitChangeCount,
        "ChatGPT製品の完全な会話履歴ではなく、Work Taskに記録された最新のChatGPT進捗です。");

    public static PublicHostRequest HostRequest(HostRequestListItem request) => new(
        request.RequestId,
        request.Type,
        request.Status,
        request.TaskId,
        Sanitize(request.TaskTitle),
        SanitizeNullable(request.ResultSummary),
        SanitizeNullable(request.Failure),
        request.CreatedAt,
        request.UpdatedAt,
        request.ClaimedAt,
        request.CompletedAt,
        request.ReportCharCount,
        request.ReportHeadingCount);

    public static PublicHostRequestDetail HostRequestDetail(HostRequestDetail detail) => new(
        HostRequest(detail.Item),
        SanitizeNullable(detail.ReportContent));

    public static PublicSkillImprovement SkillImprovement(SkillImprovementProposal proposal) => new(
        proposal.Id,
        Sanitize(proposal.SkillName),
        proposal.Status,
        proposal.StatusText,
        proposal.StatusColor,
        Sanitize(proposal.Summary),
        Sanitize(proposal.Reason),
        Sanitize(proposal.Source),
        Sanitize(proposal.ProposedBy),
        Sanitize(proposal.Diff),
        SanitizeNullable(proposal.StaleReason),
        proposal.CreatedAt,
        proposal.UpdatedAt);

    public static string SafeError(Exception ex)
    {
        _ = ex;
        return "ローカル状態の取得に失敗しました。";
    }

    public static string SafeActionError(Exception ex)
        => PublicTextSanitizer.Sanitize(string.IsNullOrWhiteSpace(ex.Message) ? "Task操作に失敗しました。" : ex.Message);

    private static string? SanitizeNullable(string? value) => string.IsNullOrWhiteSpace(value) ? value : Sanitize(value);

    private static string Sanitize(string value) => PublicTextSanitizer.Sanitize(value);
}
