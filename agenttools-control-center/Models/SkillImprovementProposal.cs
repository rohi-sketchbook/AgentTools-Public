namespace AgentToolsControlCenter.Models;

public sealed class SkillImprovementProposal
{
    public required string Id { get; init; }
    public required string SkillName { get; init; }
    public required string SkillPath { get; init; }
    public required string Status { get; init; }
    public required string Summary { get; init; }
    public required string Reason { get; init; }
    public required string Source { get; init; }
    public required string ProposedBy { get; init; }
    public required string Diff { get; init; }
    public string? SourceTaskId { get; init; }
    public string? StaleReason { get; init; }
    public DateTime CreatedAt { get; init; }
    public DateTime UpdatedAt { get; init; }

    public bool CanApprove => Status == "pending";
    public bool CanReject => Status is "pending" or "approved" or "stale";
    public bool CanApply => Status == "approved";

    public string StatusText => Status switch
    {
        "pending" => "確認待ち",
        "approved" => "承認済み",
        "rejected" => "却下",
        "applied" => "適用済み",
        "stale" => "再確認必要",
        _ => Status,
    };

    public string StatusColor => Status switch
    {
        "approved" or "applied" => "#65D4B6",
        "rejected" => "#8A96A3",
        "stale" => "#F08080",
        _ => "#F2C56B",
    };

    public string Details
    {
        get
        {
            var lines = new List<string>
            {
                $"状態: {StatusText}",
                $"Skill: {SkillName}",
                $"概要: {Summary}",
                $"理由: {Reason}",
                $"提案元: {Source} / {ProposedBy}",
                $"対象: {SkillPath}",
                $"作成: {CreatedAt:yyyy-MM-dd HH:mm:ss}",
                $"更新: {UpdatedAt:yyyy-MM-dd HH:mm:ss}",
            };
            if (!string.IsNullOrWhiteSpace(SourceTaskId)) lines.Add($"関連Task: {SourceTaskId}");
            if (!string.IsNullOrWhiteSpace(StaleReason)) lines.Add($"再確認理由: {StaleReason}");
            return string.Join(Environment.NewLine, lines);
        }
    }
}
