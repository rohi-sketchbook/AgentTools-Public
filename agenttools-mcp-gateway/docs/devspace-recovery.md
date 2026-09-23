# DevSpace Independent Recovery Path

## Purpose

AgentTools provides a recovery path that does not depend on ChatGPT or DevSpace itself.

```text
Normal development:
ChatGPT -> DevSpace -> code/search/edit -> AgentTools

Autonomous recovery:
Windows Task Scheduler -> DevSpace Watchdog -> status/recover -> DevSpace

Optional diagnostics:
CLI / AgentTools MCP Gateway -> watchdog.status/history + devspace.diagnose
```

The Watchdog is the primary SPOF mitigation. AgentTools MCP Gateway no longer needs to be registered as a second ChatGPT MCP connection merely to recover DevSpace.

## Registered DevSpace instance

The manager is registered to the validated upstream-main local port:

- root: `<WorkspaceRoot>\worktrees\devspace-pr103-8ae9f581-c1dc9bed`
- package: `@waishnav/devspace` 1.0.8
- reference upstream commit: `5a8510fd3106b8e788d99d683d7382e368ccd487`（診断用。起動条件ではない）
- local branch: `rohi/upstream-main-port`
- local endpoint: read from `~/.devspace/config.json`, currently expected to be `127.0.0.1:7676`
- health endpoint: `/healthz`
- MCP route: `/mcp`

The Gateway does not update, reinstall, pull, or rewrite this DevSpace installation.

## Workspace continuation lookup

DevSpace itself persists checkout workspace sessions and conversation bindings in its workspace database. For a stable ChatGPT conversation scope, calling `open_workspace` again for the same canonical Project path restores/reuses the existing active checkout `workspaceId`; the host should normally keep using the ID it already has and only reopen after that ID is unavailable or rejected.

AgentTools additionally exposes a read-only diagnostic fallback:

```text
devspace.workspaceLookup { path: "D:\\projects\\example-unity-project", mode: "checkout" }
```

The lookup reads DevSpace's own SQLite session state and returns the matching active/recent Workspace for the exact canonical Project path. Active sessions are preferred over inactive history. A returned active session is a reuse candidate; if only inactive history exists, the caller must use `open_workspace` rather than forcing a stale ID.

This is deliberately a lookup, not a second workspace registry. It does not create/reactivate sessions, rewrite conversation bindings, or persist `workspaceId` values into AgentTools rules. `workspaceId` remains a DevSpace-owned session handle and should not be hard-coded into `AGENTS.md`, Skills, or repository configuration.

## Health model

`devspace.status` and `devspace.health` do not equate a live PID with health.

They combine:

1. trusted DevSpace process detection
2. configured TCP listener ownership
3. `GET /healthz`
4. `/mcp` route responsiveness
5. runtime files, package version, and dependency checks
6. user config readability
7. read-only workspace database inspection

States:

| status | meaning |
|---|---|
| `healthy` | trusted process exists, health endpoint and MCP route respond, installation is startable |
| `unresponsive` | trusted process exists but health/MCP responsiveness is incomplete |
| `stopped` | no trusted process and no DevSpace endpoint response |
| `degraded` | some evidence is alive but the complete healthy contract is not satisfied |
| `unknown` | state cannot be classified reliably |

A 401 response from `/mcp` is considered route-responsive because it demonstrates that DevSpace's authenticated MCP layer is reachable without exposing credentials.

## Process ownership before stop

A process is not stopped merely because its command line contains `devspace`.

A traditional externally-started server is recognized as Node.js running `dist\cli.js serve`. A Gateway-started server is recognized by the fixed `src/devspace/supervisor.mjs` path. Ownership must also be verified by at least one trusted signal:

- it owns the configured DevSpace listening port,
- its parent command line references the configured `Start-DevSpace-Local.bat` launcher, or
- its PID/start time matches the Gateway supervisor control state.

`stop/restart/recover` re-run this ownership check immediately before termination.

## Recovery sequence

The shared internal recovery core and `devspace.recover` follow this sequence:

```text
diagnose
  -> healthy: no-op
  -> stopped: start through Gateway supervisor
  -> unresponsive/degraded and supervisor-managed: graceful shutdown request -> wait -> start -> health check
  -> externally-started or graceful shutdown failed: stop and report unless force escalation was explicitly allowed
  -> allowForce=true: force stop -> start through Gateway supervisor -> health check
```

For interactive MCP/CLI calls, force escalation remains a destructive action protected by confirmation/policy.

For the autonomous Watchdog, force escalation is governed separately by `config/watchdog.json`. The default policy waits for transient failures first: 10-second checks, recovery after 3 consecutive failures, and force escalation only after 6 consecutive failures. Force is still restricted to a DevSpace PID whose ownership was revalidated against the configured port/launcher/control metadata.

The manager deliberately refuses automatic repair when the registered installation is not safely startable, for example:

- `dist/cli.js` missing
- `dist/server.js`, `dist/config.js`, or `dist/server-shutdown.js` missing
- Gateway supervisor missing
- `package.json` missing/unreadable
- expected package version mismatch
- `node_modules` missing
- Git commit unreadable

In those cases `diagnose` recommends manual installation repair instead of running npm, git pull, install, or update automatically.

## Start implementation

Start does not invoke `.bat`, `cmd /c`, `powershell -Command`, or a user-provided command string.

The Gateway validates the runtime installation and launches the fixed Gateway supervisor with Node's process API:

```text
<fixed process.execPath> <Gateway root>\src\devspace\supervisor.mjs
```

The supervisor then imports the DevSpace runtime modules by fixed path:

```text
<DevSpace root>\dist\config.js
<DevSpace root>\dist\server.js
<DevSpace root>\dist\server-shutdown.js
```

It calls `loadConfig()`, `createServer(config)`, and `app.listen(...)`. A random local control token is stored in the Git-ignored Gateway state directory. On a verified shutdown request the supervisor calls DevSpace's own `shutdownHttpServer(httpServer, close)`, allowing HTTP drain and application cleanup before exit.

No `.bat`, `cmd /c`, `powershell -Command`, or user-provided command string is involved in start/stop control. `DEVSPACE_ARTIFACTS=1` and `DEVSPACE_SUBAGENTS=1` are preserved in the child environment.

On Windows, the registered 1.0.8 local port retains the reviewed secure-filesystem implementation for native artifact download. The Windows path pins each destination directory with Win32 handles, rejects reparse-point/junction escapes and Windows-reserved path forms, writes to an exclusive partial, verifies size/identity, and publishes without overwriting. `koffi` 3.1.2 and its matching Windows x64 native package are installed directly in the live worktree; the registered runtime does not depend on the retired rollback PR #103 checkout.

Git commit state is reported as diagnostic information only. A commit mismatch does not block restart because this checkout also contains reviewed local runtime extensions. Recovery still refuses to run package installation, updates, `git pull`, `git switch`, `git reset`, or checkout rewrites; it validates the expected package version, required runtime modules, dependencies, configured endpoint ownership, and health responses instead.

An already-running DevSpace that was started by the existing external launcher remains diagnosable, but it does not have Gateway supervisor control. The Gateway therefore refuses non-force stop/restart for that process rather than pretending that Windows `taskkill /PID` is graceful. Force termination remains separately gated as destructive.

Control Center / `devspace-manual-control.js restart` uses a bounded `state/devspace/manual-maintenance.json` marker while an operator-requested restart is in progress. The Watchdog must treat that window as planned maintenance: do not increment failure counters and do not launch recovery, including a second maintenance check immediately before recovery. The marker expires automatically if the caller dies. DevSpace startup health waiting is intentionally longer than the Watchdog probe interval because large persisted workspace databases can take more than 15 seconds to become healthy.

## Logs

A DevSpace instance started by the Gateway writes stdout/stderr to:

```text
state/devspace/devspace.log
```

The supervisor performs size-based rotation while DevSpace is running. The default policy is a 5 MiB active file plus three backups (`devspace.log.1` through `.3`), configured by `logMaxBytes` and `logBackupCount` in `config/devspace.json`. The directory is Git-ignored.

`devspace.logs` supports:

- `lines` / `tail`
- `since`
- `errorOnly`

Returned text is capped and secret-redacted.

The Gateway cannot retroactively capture stdout/stderr from a DevSpace instance that was already started by another launcher. In that case `devspace.logs` reports that no Gateway-managed log exists yet.

## Watchdog policy

`src/core/devspaceWatchdog.js` runs independently from MCP tool calls. It does not accept arbitrary executable names or command strings and delegates recovery only to the fixed DevSpace recovery core.

Default controls:

- 10 second health interval
- 3 consecutive failures before the first recovery attempt
- 6 consecutive failures before force escalation is permitted
- 20 second recovery cooldown
- maximum 5 recovery attempts per hour
- 15 minute circuit breaker after the rate limit is reached
- no automatic reinstall/update/git pull/config rewrite
- state/history under Git-ignored `state/devspace/`
- watchdog history compaction after 1 MiB, retaining the latest 200 entries by default
- single-instance lock in addition to Scheduled Task `IgnoreNew`

Read-only inspection is exposed as `watchdog.status` and `watchdog.history`.

## Safety gates

Interactive mutation tools use the existing confirmation-token system.

- `devspace.start/stop/restart`: controlled write action
- force stop/restart or `recover allowForce=true`: destructive action
- `fs.delete` / `fs.deleteRecursive`: destructive action
- `process.start/stop`: only registered process IDs are accepted

`config/safety.json` remains unchanged. With the current flags set to `false`, interactive mutation execution remains policy-blocked even after a valid confirmation token. This does not disable the independent Watchdog; its autonomous recovery permission is explicitly configured in `config/watchdog.json`.

## Filesystem boundary

`fs.exists`, `fs.stat`, `fs.list`, and `fs.readText` operate only under `config/allowed-paths.json` roots.

Deletion additionally enforces:

- canonicalization/realpath policy
- root escape rejection
- junction/symlink escape rejection
- deletion of the allowed root itself is forbidden
- non-empty directories require `fs.deleteRecursive`
- recursive preview before confirmation
- lstat fingerprint and canonical path revalidation after confirmation
- no recursive traversal through symlinks during preview

## Process boundary

Read-only process inspection is available through:

- `process.list`
- `process.find` (literal query, not a PowerShell expression)
- `process.info`
- `process.status`

Mutation accepts only IDs from `config/processes.json`. There is no arbitrary `exec(command)` Gateway tool.

## Git diagnostics

Read-only Git operations available without DevSpace are:

- `git.status`
- `git.log`
- `git.diff`
- `git.diffSummary`

They invoke the trusted Git executable directly with argument arrays. Existing guarded commit/push operations remain separately gated.

## Windows launchers

- `Start-AgentToolsGateway.bat`: starts the stdio MCP prototype with the trusted Node.js executable
- `Status-AgentToolsGateway.bat`: read-only Gateway and DevSpace health
- `Doctor-AgentToolsGateway.bat`: Gateway health + DevSpace diagnosis + registered process status
- `Install-DevSpaceWatchdog.bat`: registers and immediately starts the per-user `AgentTools-DevSpaceWatchdog` Scheduled Task. The task starts at logon and also has a one-minute repeating liveness trigger. `MultipleInstances=IgnoreNew` makes that trigger inert while the watchdog is already running, but starts a fresh instance after an unexpected exit even when Task Scheduler's `RestartOnFailure` path does not.
- `Status-DevSpaceWatchdog.bat`: shows Watchdog state and current DevSpace health
- `Uninstall-DevSpaceWatchdog.bat`: stops/unregisters only the named Watchdog Scheduled Task

There is intentionally no global `Stop-AgentToolsGateway.bat` that searches for and kills arbitrary Node.js processes. The current Gateway transport is stdio, so the MCP host owns the Gateway process lifecycle.

## Current runtime boundary

The independent recovery path is designed to run as a local Scheduled Task and therefore does not depend on ChatGPT MCP permissions. The existing ChatGPT-side DevSpace registration should remain untouched.

The Watchdog code can be validated safely with `node scripts/devspace-watchdog-test.js` and `node scripts/devspace-watchdog.js --once` while the real DevSpace stays running. Health probing remains 10-second by default, but a stable healthy state is persisted only once per `healthyPersistIntervalMs` (60 seconds by default); failures, maintenance state, recovery attempts, and status transitions are persisted immediately. Intentionally stopping or hanging the live DevSpace is a separate destructive integration test and is not required for normal installation.
