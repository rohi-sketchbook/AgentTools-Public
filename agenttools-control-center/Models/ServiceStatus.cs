using System.Text.Json.Serialization;

namespace AgentToolsControlCenter.Models;

public enum ServiceHealth
{
    Healthy,
    Warning,
    Stopped,
    Busy,
    Unknown
}

public sealed class ServiceStatus
{
    public required string Id { get; init; }
    public required string DisplayName { get; init; }
    public required ServiceHealth Health { get; init; }
    public required string StatusText { get; init; }
    public required string Summary { get; init; }
    public required string Details { get; init; }
    public required DateTimeOffset CheckedAt { get; init; }
    public string? LogPath { get; init; }
    public bool CanRecover { get; init; }

    [JsonIgnore]
    public string StatusGlyph => Health switch
    {
        ServiceHealth.Healthy => "●",
        ServiceHealth.Warning => "▲",
        ServiceHealth.Stopped => "■",
        ServiceHealth.Busy => "◆",
        _ => "?"
    };

    [JsonIgnore]
    public string StatusColor => Health switch
    {
        ServiceHealth.Healthy => "#65D4B6",
        ServiceHealth.Warning => "#F2C56B",
        ServiceHealth.Stopped => "#F06B73",
        ServiceHealth.Busy => "#74A7FF",
        _ => "#8A96A3"
    };
}
