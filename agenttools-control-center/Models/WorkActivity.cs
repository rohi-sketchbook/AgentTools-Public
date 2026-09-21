namespace AgentToolsControlCenter.Models;

public sealed class WorkActivity
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Status { get; init; }
    public string? Phase { get; init; }
    public string? CurrentWork { get; init; }
    public string? State { get; init; }
    public string? StateReason { get; init; }
    public string? Request { get; init; }
    public string? Project { get; init; }
    public string? WorkspaceRoot { get; init; }
    public string? ResumeNextStep { get; init; }
    public string? AutoResumeStatus { get; init; }
    public string? AutoResumeReason { get; init; }
    public string? ContinuationStatus { get; init; }
    public string? ContinuationProvider { get; init; }
    public string? ContinuationModel { get; init; }
    public string? ContinuationAgentId { get; init; }
    public int ContinuationAttempt { get; init; }
    public bool ContinuationSessionReused { get; init; }
    public int ContinuationSessionReuseCount { get; init; }
    public double? ContinuationUsedPercent { get; init; }
    public double? ContinuationRemainingPercent { get; init; }
    public DateTime? ContinuationStartedAt { get; init; }
    public DateTime? ContinuationFinishedAt { get; init; }
    public string? ContinuationSummary { get; init; }
    public string? ContinuationError { get; init; }
    public required string OwnerLabel { get; init; }
    public string? OwnerModel { get; init; }
    public required string ContributorsDisplay { get; init; }
    public required string WorkersDisplay { get; init; }
    public required string WorkLogDisplay { get; init; }
    public required DateTime StartedAt { get; init; }
    public required DateTime UpdatedAt { get; init; }

    public string OwnerDisplay => string.IsNullOrWhiteSpace(OwnerModel)
        ? OwnerLabel
        : $"{OwnerLabel} ({OwnerModel})";

    public string StatusText => Status switch
    {
        "succeeded" => "完了",
        "failed" => "失敗",
        "cancelled" => "中止",
        _ when ContinuationStatus is "launching" or "starting" => "Codex引継ぎ中",
        _ when ContinuationStatus == "running" => "Codex継続中",
        _ when State == "waiting_dependency" && Phase == "再開待ち" => "再開待ち",
        _ when State == "waiting_dependency" && ContinuationStatus == "completed" => "最終確認待ち",
        _ when ContinuationStatus == "failed" => "引継ぎ失敗",
        _ when State == "working" && AutoResumeStatus == "resuming" => "自動継続中",
        _ => State switch
        {
            "waiting_user" => "確認待ち",
            "waiting_dependency" => "依存待ち",
            "paused_timeout" => "時間切れ",
            "paused" => "一時停止",
            "blocked" => "待機中",
            "working" => "作業中",
            _ => Status == "blocked" ? "待機中" : "作業中",
        },
    };

    public string StatusColor => Status switch
    {
        "succeeded" => "#65D4B6",
        "failed" => "#F08080",
        "cancelled" => "#8A96A3",
        _ => State switch
        {
            "paused_timeout" => "#F08080",
            "waiting_user" or "waiting_dependency" or "paused" or "blocked" => "#F2C56B",
            _ => Status == "blocked" ? "#F2C56B" : "#65D4B6",
        },
    };
    public string WorkDisplay => string.IsNullOrWhiteSpace(CurrentWork)
        ? Phase ?? "作業中"
        : CurrentWork;

    public string ContinuationUsageDisplay
    {
        get
        {
            if (ContinuationUsedPercent is null && ContinuationRemainingPercent is null)
                return string.IsNullOrWhiteSpace(ContinuationStatus) ? string.Empty : "Codex利用枠: 未取得";
            if (ContinuationUsedPercent is not null && ContinuationRemainingPercent is not null)
                return $"Codex利用枠: {ContinuationUsedPercent:0.#}%使用 / {ContinuationRemainingPercent:0.#}%残り";
            if (ContinuationUsedPercent is not null) return $"Codex利用枠: {ContinuationUsedPercent:0.#}%使用";
            return $"Codex利用枠: {ContinuationRemainingPercent:0.#}%残り";
        }
    }

    public string Details
    {
        get
        {
            var lines = new List<string>
            {
                $"状態: {StatusText}{(string.IsNullOrWhiteSpace(Phase) ? string.Empty : $" / {Phase}")}",
                $"担当: {OwnerDisplay}",
                $"現在作業: {WorkDisplay}",
            };

            if (!string.IsNullOrWhiteSpace(StateReason)) lines.Add($"理由: {StateReason}");
            if (!string.IsNullOrWhiteSpace(ResumeNextStep)) lines.Add($"再開後の次作業: {ResumeNextStep}");
            if (!string.IsNullOrWhiteSpace(AutoResumeReason)) lines.Add($"自動継続判定: {AutoResumeReason}");
            if (!string.IsNullOrWhiteSpace(ContinuationStatus))
            {
                var provider = string.IsNullOrWhiteSpace(ContinuationProvider) ? "Codex" : ContinuationProvider;
                var model = string.IsNullOrWhiteSpace(ContinuationModel) ? string.Empty : $" ({ContinuationModel})";
                lines.Add($"自動引き継ぎ: {provider}{model} / {ContinuationStatus}");
            }
            if (!string.IsNullOrWhiteSpace(ContinuationAgentId)) lines.Add($"DevSpace Agent: {ContinuationAgentId}");
            if (ContinuationAttempt > 0) lines.Add($"引き継ぎ回数: {ContinuationAttempt}回");
            if (ContinuationSessionReused) lines.Add($"Codex Session: 継続利用（再利用{ContinuationSessionReuseCount}回）");
            if (!string.IsNullOrWhiteSpace(ContinuationUsageDisplay)) lines.Add($"{ContinuationUsageDisplay} ※アカウント全体の利用枠スナップショット（このTask単体のtoken消費量ではありません）");
            if (ContinuationStartedAt is not null) lines.Add($"Codex開始: {ContinuationStartedAt:yyyy-MM-dd HH:mm:ss}");
            if (ContinuationFinishedAt is not null) lines.Add($"Codex終了: {ContinuationFinishedAt:yyyy-MM-dd HH:mm:ss}");
            if (!string.IsNullOrWhiteSpace(ContinuationSummary)) lines.Add($"Codex結果: {ContinuationSummary}");
            if (!string.IsNullOrWhiteSpace(ContinuationError)) lines.Add($"Codexエラー: {ContinuationError}");
            if (!string.IsNullOrWhiteSpace(Request)) lines.Add($"依頼: {Request}");
            if (!string.IsNullOrWhiteSpace(Project)) lines.Add($"プロジェクト: {Project}");
            if (!string.IsNullOrWhiteSpace(WorkspaceRoot)) lines.Add($"Workspace: {WorkspaceRoot}");
            lines.Add($"開始: {StartedAt:yyyy-MM-dd HH:mm:ss}");
            lines.Add($"更新: {UpdatedAt:yyyy-MM-dd HH:mm:ss}");
            lines.Add(string.Empty);
            lines.Add("担当別の現在状況:");
            lines.Add(WorkersDisplay);

            if (!string.IsNullOrWhiteSpace(WorkLogDisplay))
            {
                lines.Add(string.Empty);
                lines.Add("作業ログ:");
                lines.Add(WorkLogDisplay);
            }

            return string.Join(Environment.NewLine, lines);
        }
    }
}
