using System.IO;
using System.Text.Json;
using AgentToolsControlCenter.Models;

namespace AgentToolsControlCenter.Services;

public class SkillImprovementCollector
{
    private readonly string _statePath;

    public SkillImprovementCollector(string agentToolsRoot)
    {
        _statePath = Path.Combine(agentToolsRoot, "agenttools-mcp-gateway", "state", "skill-improvements.json");
    }

    public string StatePath => _statePath;

    public async Task<IReadOnlyList<SkillImprovementProposal>> CollectAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_statePath)) return [];

        await using var stream = new FileStream(
            _statePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            4096,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var json = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        if (!json.RootElement.TryGetProperty("proposals", out var proposals) || proposals.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<SkillImprovementProposal>();
        foreach (var item in proposals.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var id = ReadString(item, "id");
            var status = ReadString(item, "status");
            var skillName = ReadString(item, "skillName");
            var skillPath = ReadString(item, "skillPath");
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(status)
                || string.IsNullOrWhiteSpace(skillName) || string.IsNullOrWhiteSpace(skillPath)) continue;

            result.Add(new SkillImprovementProposal
            {
                Id = id,
                SkillName = skillName,
                SkillPath = skillPath,
                Status = status,
                Summary = ReadString(item, "summary") ?? "Skill改善候補",
                Reason = ReadString(item, "reason") ?? "理由未記録",
                Source = ReadString(item, "source") ?? "agent",
                ProposedBy = ReadString(item, "proposedBy") ?? "agent",
                Diff = ReadString(item, "diff") ?? string.Empty,
                SourceTaskId = ReadString(item, "sourceTaskId"),
                StaleReason = ReadString(item, "staleReason"),
                CreatedAt = ReadDate(item, "createdAt") ?? DateTime.MinValue,
                UpdatedAt = ReadDate(item, "updatedAt") ?? DateTime.MinValue,
            });
        }

        return result
            .OrderBy(item => item.Status is "pending" or "approved" or "stale" ? 0 : 1)
            .ThenByDescending(item => item.UpdatedAt)
            .Take(50)
            .ToArray();
    }

    private static string? ReadString(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static DateTime? ReadDate(JsonElement element, string name)
    {
        var value = ReadString(element, name);
        return DateTime.TryParse(value, out var parsed) ? parsed.ToLocalTime() : null;
    }
}
