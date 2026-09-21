using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace AgentTools.WindowsUi;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    [STAThread]
    public static int Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        try
        {
            if (args.Length == 0 || args[0] is "help" or "--help" or "-h")
            {
                WriteJson(new
                {
                    ok = true,
                    usage = new[]
                    {
                        "WindowsUi windows [--process Unity.exe] [--title *Modified*] [--limit 50]",
                        "WindowsUi tree --process Unity.exe --window *Modified* [--depth 6] [--limit 500]",
                        "WindowsUi find --process Unity.exe --window *Modified* --controlType Button --name Save [--automationId id] [--limit 50]",
                        "WindowsUi invoke --process Unity.exe --window *Modified* --controlType Button --name Save [--automationId id] [--execute]",
                        "WindowsUi set-value --process chrome.exe --window *Cloudflare* --automationId subdomain --value control [--execute]",
                        "WindowsUi expand --process chrome.exe --window *Cloudflare* --automationId selector [--execute]",
                        "WindowsUi select --process chrome.exe --window *Cloudflare* --name Option [--execute]",
                        "WindowsUi click-center --process chrome.exe --window *Cloudflare* --automationId id [--name Option] [--execute]",
                    },
                    note = "invoke is dry-run unless --execute is supplied. Process and window are mandatory for invoke.",
                });
                return 0;
            }

            var command = args[0].ToLowerInvariant();
            var options = CliOptions.Parse(args.Skip(1).ToArray());
            return command switch
            {
                "windows" => ListWindows(options),
                "tree" => DumpTree(options),
                "find" => FindControls(options),
                "invoke" => InvokeControl(options),
                "set-value" => SetValueControl(options),
                "expand" => ExpandControl(options),
                "select" => SelectControl(options),
                "click-center" => ClickCenterControl(options),
                _ => Fail($"Unknown command: {args[0]}")
            };
        }
        catch (Exception ex)
        {
            return Fail(ex.Message, ex.GetType().Name);
        }
    }

    private static int ListWindows(CliOptions options)
    {
        var limit = options.GetInt("limit", 50, 1, 200);
        var windows = ResolveWindows(options.Get("process"), options.Get("title"), limit);
        WriteJson(new
        {
            ok = true,
            count = windows.Count,
            windows = windows.Select(ToElementInfo).ToArray(),
        });
        return 0;
    }

    private static int DumpTree(CliOptions options)
    {
        EnsureWindowSelector(options);
        var depth = options.GetInt("depth", 6, 0, 20);
        var limit = options.GetInt("limit", 500, 1, 5000);
        var windows = ResolveWindows(options.Get("process"), options.Get("window"), 20);
        if (windows.Count == 0) return Fail("No matching window found.");
        if (windows.Count > 1) return Fail("Window selector matched multiple windows. Narrow --process/--window before tree inspection.", data: windows.Select(ToElementInfo).ToArray());

        var rows = new List<object>();
        WalkTree(windows[0], depth, limit, (element, currentDepth) =>
        {
            rows.Add(new { depth = currentDepth, element = ToElementInfo(element) });
            return rows.Count < limit;
        });

        WriteJson(new
        {
            ok = true,
            window = ToElementInfo(windows[0]),
            count = rows.Count,
            truncated = rows.Count >= limit,
            elements = rows,
        });
        return 0;
    }

    private static int FindControls(CliOptions options)
    {
        EnsureWindowSelector(options);
        EnsureControlSelector(options, requireNameOrId: false);
        var limit = options.GetInt("limit", 50, 1, 500);
        var windows = ResolveWindows(options.Get("process"), options.Get("window"), 20);
        if (windows.Count == 0) return Fail("No matching window found.");
        if (windows.Count > 1) return Fail("Window selector matched multiple windows. Narrow --process/--window before searching controls.", data: windows.Select(ToElementInfo).ToArray());

        var matches = FindMatchingControls(windows[0], options, limit);
        WriteJson(new
        {
            ok = true,
            window = ToElementInfo(windows[0]),
            count = matches.Count,
            controls = matches.Select(ToElementInfo).ToArray(),
        });
        return 0;
    }

    private static int InvokeControl(CliOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.Get("process")))
            return Fail("invoke requires --process.");
        if (string.IsNullOrWhiteSpace(options.Get("window")))
            return Fail("invoke requires --window.");
        EnsureControlSelector(options, requireNameOrId: true);

        var windows = ResolveWindows(options.Get("process"), options.Get("window"), 20);
        if (windows.Count == 0) return Fail("No matching window found.");
        if (windows.Count > 1) return Fail("Window selector matched multiple windows. Refusing invoke until exactly one window matches.", data: windows.Select(ToElementInfo).ToArray());

        var matches = FindMatchingControls(windows[0], options, 20);
        if (matches.Count == 0) return Fail("No matching control found.");
        if (matches.Count > 1)
            return Fail("Control selector matched multiple controls. Refusing invoke until exactly one control matches; add --automationId or a narrower --name.", data: matches.Select(ToElementInfo).ToArray());

        var target = matches[0];
        var windowCurrent = windows[0].Current;
        var targetCurrent = target.Current;
        var preview = new
        {
            window = ToElementInfo(windows[0]),
            control = ToElementInfo(target),
            action = "InvokePattern.Invoke",
        };

        if (options.Get("expectedProcessId") is { } expectedProcessIdRaw
            && (!int.TryParse(expectedProcessIdRaw, out var expectedProcessId) || targetCurrent.ProcessId != expectedProcessId))
            return Fail("Target process changed after preview; refusing invoke.", data: preview);
        if (options.Get("expectedWindowHandle") is { } expectedWindowHandleRaw
            && (!int.TryParse(expectedWindowHandleRaw, out var expectedWindowHandle) || windowCurrent.NativeWindowHandle != expectedWindowHandle))
            return Fail("Target window changed after preview; refusing invoke.", data: preview);
        if (options.Get("expectedControlHandle") is { } expectedControlHandleRaw
            && (!int.TryParse(expectedControlHandleRaw, out var expectedControlHandle) || targetCurrent.NativeWindowHandle != expectedControlHandle))
            return Fail("Target control changed after preview; refusing invoke.", data: preview);

        if (!options.HasFlag("execute"))
        {
            WriteJson(new { ok = true, dryRun = true, wouldInvoke = preview });
            return 0;
        }

        if (!target.Current.IsEnabled)
            return Fail("Target control is disabled; refusing invoke.", data: preview);
        if (!target.TryGetCurrentPattern(InvokePattern.Pattern, out var patternObject) || patternObject is not InvokePattern pattern)
            return Fail("Target control does not expose InvokePattern.", data: preview);

        pattern.Invoke();
        WriteJson(new { ok = true, dryRun = false, invoked = preview });
        return 0;
    }

    private static int SetValueControl(CliOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.Get("process")))
            return Fail("set-value requires --process.");
        if (string.IsNullOrWhiteSpace(options.Get("window")))
            return Fail("set-value requires --window.");
        EnsureControlSelector(options, requireNameOrId: true);
        if (options.Get("value") is not { } value)
            return Fail("set-value requires --value.");

        var windows = ResolveWindows(options.Get("process"), options.Get("window"), 20);
        if (windows.Count == 0) return Fail("No matching window found.");
        if (windows.Count > 1) return Fail("Window selector matched multiple windows. Refusing set-value until exactly one window matches.", data: windows.Select(ToElementInfo).ToArray());

        var matches = FindMatchingControls(windows[0], options, 20);
        if (matches.Count == 0) return Fail("No matching control found.");
        if (matches.Count > 1)
            return Fail("Control selector matched multiple controls. Refusing set-value until exactly one control matches; add --automationId or a narrower --name.", data: matches.Select(ToElementInfo).ToArray());

        var target = matches[0];
        var windowCurrent = windows[0].Current;
        var targetCurrent = target.Current;
        var preview = new
        {
            window = ToElementInfo(windows[0]),
            control = ToElementInfo(target),
            action = "ValuePattern.SetValue",
            valueLength = value.Length,
        };

        if (options.Get("expectedProcessId") is { } expectedProcessIdRaw
            && (!int.TryParse(expectedProcessIdRaw, out var expectedProcessId) || targetCurrent.ProcessId != expectedProcessId))
            return Fail("Target process changed after preview; refusing set-value.", data: preview);
        if (options.Get("expectedWindowHandle") is { } expectedWindowHandleRaw
            && (!int.TryParse(expectedWindowHandleRaw, out var expectedWindowHandle) || windowCurrent.NativeWindowHandle != expectedWindowHandle))
            return Fail("Target window changed after preview; refusing set-value.", data: preview);

        if (!options.HasFlag("execute"))
        {
            WriteJson(new { ok = true, dryRun = true, wouldSetValue = preview });
            return 0;
        }

        if (!target.Current.IsEnabled)
            return Fail("Target control is disabled; refusing set-value.", data: preview);
        if (!target.TryGetCurrentPattern(ValuePattern.Pattern, out var patternObject) || patternObject is not ValuePattern pattern)
            return Fail("Target control does not expose ValuePattern.", data: preview);
        if (pattern.Current.IsReadOnly)
            return Fail("Target control is read-only; refusing set-value.", data: preview);

        pattern.SetValue(value);
        WriteJson(new { ok = true, dryRun = false, setValue = preview });
        return 0;
    }

    private static int ExpandControl(CliOptions options)
    {
        return RunPatternAction(
            options,
            "expand",
            ExpandCollapsePattern.Pattern,
            "ExpandCollapsePattern.Expand",
            target => ((ExpandCollapsePattern)target).Expand());
    }

    private static int SelectControl(CliOptions options)
    {
        return RunPatternAction(
            options,
            "select",
            SelectionItemPattern.Pattern,
            "SelectionItemPattern.Select",
            target => ((SelectionItemPattern)target).Select());
    }

    private static int ClickCenterControl(CliOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.Get("process")))
            return Fail("click-center requires --process.");
        if (string.IsNullOrWhiteSpace(options.Get("window")))
            return Fail("click-center requires --window.");
        EnsureControlSelector(options, requireNameOrId: true);

        var windows = ResolveWindows(options.Get("process"), options.Get("window"), 20);
        if (windows.Count == 0) return Fail("No matching window found.");
        if (windows.Count > 1) return Fail("Window selector matched multiple windows. Refusing click-center until exactly one window matches.", data: windows.Select(ToElementInfo).ToArray());

        var matches = FindMatchingControls(windows[0], options, 20);
        if (matches.Count == 0) return Fail("No matching control found.");
        if (matches.Count > 1)
            return Fail("Control selector matched multiple controls. Refusing click-center until exactly one control matches; add --automationId or a narrower --name.", data: matches.Select(ToElementInfo).ToArray());

        var target = matches[0];
        var current = target.Current;
        var rect = current.BoundingRectangle;
        if (rect.IsEmpty || double.IsNaN(rect.X) || double.IsNaN(rect.Y) || rect.Width <= 0 || rect.Height <= 0)
            return Fail("Target control has no usable bounding rectangle.", data: ToElementInfo(target));
        if (current.IsOffscreen)
            return Fail("Target control is offscreen; refusing click-center.", data: ToElementInfo(target));

        var x = checked((int)Math.Round(rect.X + rect.Width / 2));
        var y = checked((int)Math.Round(rect.Y + rect.Height / 2));
        var preview = new
        {
            window = ToElementInfo(windows[0]),
            control = ToElementInfo(target),
            action = "Native left click at control center",
            point = new { x, y },
        };

        if (!options.HasFlag("execute"))
        {
            WriteJson(new { ok = true, dryRun = true, wouldClick = preview });
            return 0;
        }

        if (!current.IsEnabled)
            return Fail("Target control is disabled; refusing click-center.", data: preview);

        GetCursorPos(out var oldPoint);
        if (!SetCursorPos(x, y))
            return Fail("SetCursorPos failed.", data: preview);
        Thread.Sleep(60);
        mouse_event(MouseEventLeftDown, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(40);
        mouse_event(MouseEventLeftUp, 0, 0, 0, UIntPtr.Zero);
        Thread.Sleep(80);
        SetCursorPos(oldPoint.X, oldPoint.Y);

        WriteJson(new { ok = true, dryRun = false, clicked = preview });
        return 0;
    }

    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    private static int RunPatternAction(
        CliOptions options,
        string commandName,
        AutomationPattern requiredPattern,
        string actionName,
        Action<object> executeAction)
    {
        if (string.IsNullOrWhiteSpace(options.Get("process")))
            return Fail($"{commandName} requires --process.");
        if (string.IsNullOrWhiteSpace(options.Get("window")))
            return Fail($"{commandName} requires --window.");
        EnsureControlSelector(options, requireNameOrId: true);

        var windows = ResolveWindows(options.Get("process"), options.Get("window"), 20);
        if (windows.Count == 0) return Fail("No matching window found.");
        if (windows.Count > 1) return Fail($"Window selector matched multiple windows. Refusing {commandName} until exactly one window matches.", data: windows.Select(ToElementInfo).ToArray());

        var matches = FindMatchingControls(windows[0], options, 20);
        if (matches.Count == 0) return Fail("No matching control found.");
        if (matches.Count > 1)
            return Fail($"Control selector matched multiple controls. Refusing {commandName} until exactly one control matches; add --automationId or a narrower --name.", data: matches.Select(ToElementInfo).ToArray());

        var target = matches[0];
        var preview = new
        {
            window = ToElementInfo(windows[0]),
            control = ToElementInfo(target),
            action = actionName,
        };

        if (!options.HasFlag("execute"))
        {
            WriteJson(new { ok = true, dryRun = true, action = preview });
            return 0;
        }

        if (!target.Current.IsEnabled)
            return Fail($"Target control is disabled; refusing {commandName}.", data: preview);
        if (!target.TryGetCurrentPattern(requiredPattern, out var patternObject) || patternObject is null)
            return Fail($"Target control does not expose the required pattern for {commandName}.", data: preview);

        executeAction(patternObject);
        WriteJson(new { ok = true, dryRun = false, action = preview });
        return 0;
    }

    private static void EnsureWindowSelector(CliOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.Get("process")) && string.IsNullOrWhiteSpace(options.Get("window")))
            throw new ArgumentException("Specify at least --process or --window.");
    }

    private static void EnsureControlSelector(CliOptions options, bool requireNameOrId)
    {
        if (requireNameOrId && string.IsNullOrWhiteSpace(options.Get("name")) && string.IsNullOrWhiteSpace(options.Get("automationId")))
            throw new ArgumentException("Specify --name or --automationId for invoke.");
    }

    private static List<AutomationElement> ResolveWindows(string? processFilter, string? titlePattern, int limit)
    {
        HashSet<int>? processIds = null;
        if (!string.IsNullOrWhiteSpace(processFilter))
        {
            var normalized = NormalizeProcessName(processFilter);
            processIds = Process.GetProcesses()
                .Where(p => string.Equals(p.ProcessName, normalized, StringComparison.OrdinalIgnoreCase))
                .Select(p => p.Id)
                .ToHashSet();
            if (processIds.Count == 0) return new List<AutomationElement>();
        }

        var result = new List<AutomationElement>();
        var handles = new HashSet<int>();
        var root = AutomationElement.RootElement;
        var children = root.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement element in children)
        {
            if (result.Count >= limit) break;
            try
            {
                var current = element.Current;
                if (current.NativeWindowHandle == 0) continue;
                if (processIds is not null && !processIds.Contains(current.ProcessId)) continue;

                AddWindowIfMatched(element, titlePattern, processIds, result, handles, limit);
                if (result.Count >= limit) break;

                // With a process filter, include modal/owned child windows as addressable windows.
                // Unity's native confirmation dialogs are exposed this way under the editor window.
                if (processIds is not null)
                {
                    WalkTree(element, 8, 5000, (candidate, depth) =>
                    {
                        if (depth == 0) return true;
                        try
                        {
                            var candidateCurrent = candidate.Current;
                            if (candidateCurrent.ControlType == ControlType.Window)
                                AddWindowIfMatched(candidate, titlePattern, processIds, result, handles, limit);
                        }
                        catch (ElementNotAvailableException)
                        {
                        }
                        return result.Count < limit;
                    });
                }
            }
            catch (ElementNotAvailableException)
            {
                // Window disappeared while enumerating; ignore it.
            }
        }
        return result;
    }

    private static void AddWindowIfMatched(
        AutomationElement element,
        string? titlePattern,
        HashSet<int>? processIds,
        List<AutomationElement> result,
        HashSet<int> handles,
        int limit)
    {
        if (result.Count >= limit) return;
        var current = element.Current;
        if (current.NativeWindowHandle == 0) return;
        if (processIds is not null && !processIds.Contains(current.ProcessId)) return;
        if (!GlobMatch(current.Name ?? string.Empty, titlePattern)) return;
        if (!handles.Add(current.NativeWindowHandle)) return;
        result.Add(element);
    }

    private static List<AutomationElement> FindMatchingControls(AutomationElement window, CliOptions options, int limit)
    {
        var controlType = options.Get("controlType");
        var name = options.Get("name");
        var automationId = options.Get("automationId");
        var matches = new List<AutomationElement>();

        WalkTree(window, 20, Math.Max(limit * 50, 1000), (element, depth) =>
        {
            if (depth == 0) return true;
            try
            {
                var current = element.Current;
                if (!string.IsNullOrWhiteSpace(controlType)
                    && !string.Equals(ControlTypeName(current.ControlType), controlType, StringComparison.OrdinalIgnoreCase))
                    return true;
                if (!GlobMatch(current.Name ?? string.Empty, name)) return true;
                if (!GlobMatch(current.AutomationId ?? string.Empty, automationId)) return true;
                matches.Add(element);
                return matches.Count < limit;
            }
            catch (ElementNotAvailableException)
            {
                return true;
            }
        });
        return matches;
    }

    private static void WalkTree(AutomationElement root, int maxDepth, int visitLimit, Func<AutomationElement, int, bool> visitor)
    {
        var visited = 0;
        var stack = new Stack<(AutomationElement Element, int Depth)>();
        stack.Push((root, 0));
        var walker = TreeWalker.ControlViewWalker;

        while (stack.Count > 0 && visited < visitLimit)
        {
            var (element, depth) = stack.Pop();
            visited++;
            if (!visitor(element, depth)) break;
            if (depth >= maxDepth) continue;

            var children = new List<AutomationElement>();
            try
            {
                for (var child = walker.GetFirstChild(element); child is not null; child = walker.GetNextSibling(child))
                    children.Add(child);
            }
            catch (ElementNotAvailableException)
            {
                continue;
            }

            for (var i = children.Count - 1; i >= 0; i--)
                stack.Push((children[i], depth + 1));
        }
    }

    private static object ToElementInfo(AutomationElement element)
    {
        try
        {
            var c = element.Current;
            var rect = c.BoundingRectangle;
            return new
            {
                name = c.Name,
                controlType = ControlTypeName(c.ControlType),
                automationId = c.AutomationId,
                className = c.ClassName,
                frameworkId = c.FrameworkId,
                processId = c.ProcessId,
                nativeWindowHandle = c.NativeWindowHandle,
                isEnabled = c.IsEnabled,
                isOffscreen = c.IsOffscreen,
                boundingRectangle = rect.IsEmpty ? null : new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height },
                patterns = SupportedPatternNames(element),
            };
        }
        catch (ElementNotAvailableException)
        {
            return new { unavailable = true };
        }
    }

    private static string[] SupportedPatternNames(AutomationElement element)
    {
        var patterns = new List<string>();
        TryPattern(element, InvokePattern.Pattern, "Invoke", patterns);
        TryPattern(element, ValuePattern.Pattern, "Value", patterns);
        TryPattern(element, SelectionItemPattern.Pattern, "SelectionItem", patterns);
        TryPattern(element, SelectionPattern.Pattern, "Selection", patterns);
        TryPattern(element, ExpandCollapsePattern.Pattern, "ExpandCollapse", patterns);
        TryPattern(element, TogglePattern.Pattern, "Toggle", patterns);
        return patterns.ToArray();
    }

    private static void TryPattern(AutomationElement element, AutomationPattern pattern, string name, List<string> output)
    {
        try
        {
            if (element.TryGetCurrentPattern(pattern, out _)) output.Add(name);
        }
        catch (ElementNotAvailableException)
        {
        }
    }

    private static string ControlTypeName(ControlType? controlType)
        => controlType?.ProgrammaticName?.Replace("ControlType.", string.Empty, StringComparison.OrdinalIgnoreCase) ?? string.Empty;

    private static string NormalizeProcessName(string processName)
    {
        var value = Path.GetFileName(processName.Trim());
        return value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? value[..^4] : value;
    }

    private static bool GlobMatch(string value, string? pattern)
    {
        if (string.IsNullOrWhiteSpace(pattern)) return true;
        var regex = "^" + Regex.Escape(pattern.Trim()).Replace("\\*", ".*").Replace("\\?", ".") + "$";
        return Regex.IsMatch(value ?? string.Empty, regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    private static int Fail(string error, string? type = null, object? data = null)
    {
        WriteJson(new { ok = false, error, type, data });
        return 1;
    }

    private static void WriteJson(object value)
        => Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
}

internal sealed class CliOptions
{
    private readonly Dictionary<string, string?> _values = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _flags = new(StringComparer.OrdinalIgnoreCase);

    public static CliOptions Parse(string[] args)
    {
        var result = new CliOptions();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"Unexpected argument: {arg}");
            var key = arg[2..];
            if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("Empty option name.");
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                result._values[key] = args[++i];
            }
            else
            {
                result._flags.Add(key);
            }
        }
        return result;
    }

    public string? Get(string name) => _values.TryGetValue(name, out var value) ? value : null;
    public bool HasFlag(string name) => _flags.Contains(name);

    public int GetInt(string name, int defaultValue, int min, int max)
    {
        var raw = Get(name);
        if (raw is null) return defaultValue;
        if (!int.TryParse(raw, out var value)) throw new ArgumentException($"--{name} must be an integer.");
        return Math.Clamp(value, min, max);
    }
}
