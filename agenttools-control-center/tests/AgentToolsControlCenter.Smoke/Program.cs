using AgentToolsControlCenter.Models;
using AgentToolsControlCenter.Services;

var collector = new StatusCollector();
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
var statuses = await collector.CollectAsync(cts.Token);
var taskCollector = new ActivityCollector(collector.AgentToolsRoot);
var tasks = await taskCollector.CollectAsync(cts.Token);

Console.OutputEncoding = System.Text.Encoding.UTF8;
Console.WriteLine($"AgentTools root: {collector.AgentToolsRoot}");
foreach (var status in statuses)
{
    Console.WriteLine($"{status.Id,-12} {status.Health,-8} {status.StatusText,-10} {status.Summary}");
}
Console.WriteLine($"User tasks: {tasks.Count}");
foreach (var task in tasks)
{
    Console.WriteLine($"  {task.Id} {task.StatusText} {task.Title} | {task.WorkersDisplay.Replace(Environment.NewLine, " / ")}");
}

if (statuses.Count != 8)
{
    Console.Error.WriteLine($"Expected 8 statuses, got {statuses.Count}.");
    return 1;
}

if (statuses.Any(status => string.IsNullOrWhiteSpace(status.DisplayName) || string.IsNullOrWhiteSpace(status.Details)))
{
    Console.Error.WriteLine("One or more status records are incomplete.");
    return 2;
}

if (tasks.Any(task => string.IsNullOrWhiteSpace(task.Details)))
{
    Console.Error.WriteLine("One or more task detail records are incomplete.");
    return 3;
}

var stateSamples = new[]
{
    (State: "working", Status: "running", Expected: "作業中"),
    (State: "waiting_user", Status: "blocked", Expected: "確認待ち"),
    (State: "waiting_dependency", Status: "blocked", Expected: "依存待ち"),
    (State: "paused_timeout", Status: "blocked", Expected: "時間切れ"),
    (State: "paused", Status: "blocked", Expected: "一時停止"),
};
foreach (var sample in stateSamples)
{
    var item = new WorkActivity
    {
        Id = "sample",
        Title = "sample",
        Status = sample.Status,
        State = sample.State,
        StateReason = sample.State == "working" ? null : "理由",
        OwnerLabel = "ChatGPT",
        ContributorsDisplay = "ChatGPT",
        WorkersDisplay = "ChatGPT: sample",
        WorkLogDisplay = string.Empty,
        StartedAt = DateTime.Now,
        UpdatedAt = DateTime.Now,
    };
    if (item.StatusText != sample.Expected)
    {
        Console.Error.WriteLine($"State {sample.State} mapped to {item.StatusText}, expected {sample.Expected}.");
        return 4;
    }
    if (sample.State != "working" && !item.Details.Contains("理由: 理由", StringComparison.Ordinal))
    {
        Console.Error.WriteLine($"State reason missing from task details for {sample.State}.");
        return 5;
    }
}

var autoResuming = new WorkActivity
{
    Id = "auto-resume",
    Title = "auto resume",
    Status = "running",
    State = "working",
    StateReason = "実行時間上限に到達したため、チェックポイントから自動継続",
    ResumeNextStep = "Unityローカル検証",
    AutoResumeStatus = "resuming",
    AutoResumeReason = "安全なローカル作業として自動継続可能",
    OwnerLabel = "ChatGPT",
    ContributorsDisplay = "ChatGPT",
    WorkersDisplay = "ChatGPT: Unityローカル検証",
    WorkLogDisplay = string.Empty,
    StartedAt = DateTime.Now,
    UpdatedAt = DateTime.Now,
};
if (autoResuming.StatusText != "自動継続中"
    || !autoResuming.Details.Contains("再開後の次作業: Unityローカル検証", StringComparison.Ordinal)
    || !autoResuming.Details.Contains("自動継続判定: 安全なローカル作業として自動継続可能", StringComparison.Ordinal))
{
    Console.Error.WriteLine("Auto-resume task display mapping failed.");
    return 6;
}

var codexContinuing = new WorkActivity
{
    Id = "codex-continuation",
    Title = "codex continuation",
    Status = "running",
    State = "working",
    ContinuationStatus = "running",
    ContinuationProvider = "codex",
    ContinuationModel = "gpt-6-astra",
    ContinuationAgentId = "agt_test",
    ContinuationAttempt = 2,
    ContinuationSessionReused = true,
    ContinuationSessionReuseCount = 1,
    ContinuationUsedPercent = 31.5,
    ContinuationRemainingPercent = 68.5,
    ContinuationStartedAt = DateTime.Now,
    OwnerLabel = "Codex",
    OwnerModel = "gpt-6-astra",
    ContributorsDisplay = "ChatGPT / Codex",
    WorkersDisplay = "Codex (gpt-6-astra): ローカル検証",
    WorkLogDisplay = string.Empty,
    StartedAt = DateTime.Now,
    UpdatedAt = DateTime.Now,
};
if (codexContinuing.StatusText != "Codex継続中"
    || codexContinuing.ContinuationUsageDisplay != "Codex利用枠: 31.5%使用 / 68.5%残り"
    || !codexContinuing.Details.Contains("DevSpace Agent: agt_test", StringComparison.Ordinal)
    || !codexContinuing.Details.Contains("引き継ぎ回数: 2回", StringComparison.Ordinal)
    || !codexContinuing.Details.Contains("Codex Session: 継続利用（再利用1回）", StringComparison.Ordinal)
    || !codexContinuing.Details.Contains("Codex利用枠: 31.5%使用 / 68.5%残り", StringComparison.Ordinal)
    || !codexContinuing.Details.Contains("このTask単体のtoken消費量ではありません", StringComparison.Ordinal))
{
    Console.Error.WriteLine("Codex continuation task display mapping failed.");
    return 7;
}

var codexUsageUnknown = new WorkActivity
{
    Id = "codex-usage-unknown",
    Title = "codex usage unknown",
    Status = "running",
    State = "working",
    ContinuationStatus = "running",
    ContinuationModel = "gpt-6-astra",
    OwnerLabel = "Codex",
    ContributorsDisplay = "ChatGPT / Codex",
    WorkersDisplay = "Codex: 継続中",
    WorkLogDisplay = string.Empty,
    StartedAt = DateTime.Now,
    UpdatedAt = DateTime.Now,
};
if (codexUsageUnknown.ContinuationUsageDisplay != "Codex利用枠: 未取得")
{
    Console.Error.WriteLine("Unknown Codex usage must not render as 0 / 0%.");
    return 8;
}

var legacyBlocked = new WorkActivity
{
    Id = "legacy-blocked",
    Title = "legacy blocked",
    Status = "blocked",
    State = null,
    OwnerLabel = "ChatGPT",
    ContributorsDisplay = "ChatGPT",
    WorkersDisplay = "[待機] ChatGPT: legacy",
    WorkLogDisplay = string.Empty,
    StartedAt = DateTime.Now,
    UpdatedAt = DateTime.Now,
};
if (legacyBlocked.StatusText != "待機中" || legacyBlocked.StatusColor != "#F2C56B")
{
    Console.Error.WriteLine("Legacy blocked task must remain visibly waiting/yellow when state is absent.");
    return 7;
}

var fixtureRoot = Path.Combine(Path.GetTempPath(), $"agenttools-control-center-task-fixture-{Guid.NewGuid():N}");
try
{
    var fixtureState = Path.Combine(fixtureRoot, "agenttools-mcp-gateway", "state");
    Directory.CreateDirectory(fixtureState);
    var now = DateTimeOffset.UtcNow.ToString("O");
    var json = $$"""
    {
      "tasks": [
        {
          "id": "task_20260902000000_aaaaaaaa",
          "type": "work",
          "status": "blocked",
          "title": "legacy blocked",
          "createdAt": "{{now}}",
          "updatedAt": "{{now}}",
          "startedAt": "{{now}}",
          "work": {
            "phase": "待機",
            "currentWork": "旧形式の待機",
            "owner": { "id": "chatgpt", "label": "ChatGPT", "model": "GPT-5.6 Sol" }
          }
        },
        {
          "id": "task_20260902000001_bbbbbbbb",
          "type": "work",
          "status": "blocked",
          "title": "new waiting",
          "createdAt": "{{now}}",
          "updatedAt": "{{now}}",
          "startedAt": "{{now}}",
          "work": {
            "phase": "確認待ち",
            "currentWork": "実装とテスト完了",
            "state": "waiting_user",
            "stateReason": "ユーザーの確認待ち",
            "owner": { "id": "chatgpt", "label": "ChatGPT", "model": "GPT-5.6 Sol" }
          }
        }
      ]
    }
    """;
    await File.WriteAllTextAsync(Path.Combine(fixtureState, "tasks.json"), json);
    var fixtureTasks = await new ActivityCollector(fixtureRoot).CollectAsync();
    var oldTask = fixtureTasks.Single(item => item.Title == "legacy blocked");
    var newTask = fixtureTasks.Single(item => item.Title == "new waiting");
    if (oldTask.StatusText != "待機中" || oldTask.StatusColor != "#F2C56B")
    {
        Console.Error.WriteLine("ActivityCollector legacy blocked fixture mapping failed.");
        return 8;
    }
    if (newTask.StatusText != "確認待ち" || newTask.StateReason != "ユーザーの確認待ち")
    {
        Console.Error.WriteLine("ActivityCollector state/stateReason fixture mapping failed.");
        return 9;
    }
}
finally
{
    if (Directory.Exists(fixtureRoot)) Directory.Delete(fixtureRoot, recursive: true);
}

return 0;
