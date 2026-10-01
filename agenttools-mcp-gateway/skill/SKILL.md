---
name: work-task
description: Track user-requested coding and AgentTools work as Task records. Use for substantive DevSpace development tasks, especially when ChatGPT and Codex work in parallel or hand work off. Task is the user-visible source of truth for Control Center and terminal Discord notifications.
---

# Work Task Reporting

Operational canonical document: `<AgentToolsRoot>\agenttools-mcp-gateway\docs\agent-work-orchestration.md`.

Use one user-visible Task for one substantive user request. Do not create one for trivial read-only answers or tiny status checks.

The user-visible source of truth is the `type=work` Task in `state/tasks.json`. Gateway execution records used for Unity, Blender, Local AI, video rendering, and similar child processes are internal execution jobs and must not be presented as user Tasks.

Canonical CLI:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task ...
```

Legacy `activity.*` commands remain compatibility entry points only. New work must use `task.*`.

## Start

At the beginning of substantive work, first inspect resumable Tasks. If a matching Task for the same user request/project/workspace has a persisted checkpoint **or a Control Center continue request**, reuse it instead of creating a duplicate Task. A continue-requested Task may legitimately have no `resumeContext`; in that case reconstruct the remaining work from the Task request/current work/work log and the existing DevSpace workspace rather than pretending a checkpoint exists. If the user pasted a Control Center resume prompt containing an explicit `Task ID`, inspect and reuse that Task directly even when it has no checkpoint/continue-request marker; never create a duplicate merely because it is absent from `task resumable`.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task resumable --limit 20
```

If there is no matching resumable Task, create the Task and keep the returned `task_...` id for the rest of the request.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task start --title "<short title>" --request "<user request>" --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol" --project "<project>" --workspaceRoot "<root>" --phase "調査" --message "<current work>"
```

Use the actual ChatGPT model label when known.

## DevSpace continuation guard

When a substantive development Task is already in progress, continuation intent takes precedence over attachment modality. `@devspace`, `続けて`, `継続`, `作業再開`, `ワークスペースを開きなおして`, `前の作業を続けて`, `実装を続行`, `continue`, `resume`, and `reopen workspace` are continuation signals.

- Reuse the current Task instead of creating a duplicate.
- If the same Project's DevSpace `workspaceId` is still known, keep using it. Call `open_workspace` only when that ID is unavailable/rejected or the Project/worktree actually changes.
- If the `workspaceId` was lost but the Project absolute path is known, reopen that same path/mode; DevSpace can restore the persisted checkout workspace for the same conversation. If AgentTools Gateway is available, `devspace.workspaceLookup` may be used as a read-only Project path -> active/recent Workspace diagnostic.
- Treat attached Unity/game/render screenshots as diagnostic/reference input unless the user explicitly asks to edit, process, or generate the image itself. Do not turn `screenshot + code/model/material fix` into an image-editing Task.
- Do not substitute a handoff note, instruction sheet, or one-copy text for requested development work unless the user explicitly asked for that text artifact.
- `work.workspaceRoot` is a filesystem path, not a DevSpace `workspaceId`; do not conflate them or persist a session-specific ID as a repository constant.

For long, multi-phase, or verification-sensitive work, define a Goal Contract at start or immediately afterward. This turns completion into an explicit contract rather than a free-form judgement.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task goal --id <taskId> --actor chatgpt --goalOutcome "<desired outcome>" --goalCriteria "<completion criterion>" --goalVerification "<required verification>" --goalConstraints "<boundary>" --goalEnforce true
```

When `goalEnforce=true`, success completion is refused until `task judge --goalResult satisfied` records verification evidence. Use `continue` when more work remains and `blocked` when the Goal cannot proceed without a dependency or decision.

## Progress and actor changes

Update only at meaningful phase changes, delegation, handoff, blocking, testing, and integration. Do not emit an update for every file read or command.

ChatGPT progress:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task update --id <taskId> --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol" --phase "設計" --message "既存構造を確認して実装方針を整理中" --workerStatus running
```

Codex delegation:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task update --id <taskId> --actor codex --actorLabel Codex --model "GPT-6.1 Sol" --phase "実装" --message "設定UIの単純実装を担当" --workerStatus running
```

Parallel work is represented by leaving both workers `running`. Control Center shows the same Task with both workers.

When one worker finishes its portion without completing the overall user request:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task update --id <taskId> --actor codex --actorLabel Codex --model "GPT-6.1 Sol" --phase "実装完了" --message "変更をChatGPTへ引き渡し" --workerStatus done
```

When ownership really moves, add `--takeOwnership true`. A quota-limit handoff from Codex to ChatGPT should mark Codex `done` or `blocked`, then update ChatGPT as `running` with ownership.

Use the user-visible `state` and short `reason` to explain why an active Task is or is not making progress. Supported states are `working`, `waiting_user`, `waiting_dependency`, `paused_timeout`, `paused`, and `blocked`. Non-working states automatically imply overall `blocked` unless `status` is explicitly supplied; `working` implies `running`.

Examples:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task update --id <taskId> --actor chatgpt --state waiting_user --phase "確認待ち" --message "実装とテスト完了" --reason "ユーザーの確認待ち" --workerStatus blocked
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task update --id <taskId> --actor chatgpt --state paused_timeout --phase "停止" --message "実行時間上限で停止" --reason "実行時間上限に到達。再開可能" --workerStatus blocked
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task update --id <taskId> --actor chatgpt --state working --phase "再開" --message "作業を再開" --workerStatus running
```

Always keep `reason` concise and user-facing. It should answer why the Task is waiting, paused, timed out, or blocked rather than repeating the phase name.

If the overall request is waiting on a user decision or external prerequisite, use the matching state and set the responsible worker `--workerStatus blocked`.

Each `task.update` also refreshes that worker's run heartbeat. Mark meaningful progress with `--progressMade true` and preferably a stable `--progressSignature`; ordinary phase/message churn should not be used to reset crash-loop counters. For a lightweight heartbeat without adding a work-log entry:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task heartbeat --id <taskId> --actor codex --actorLabel Codex --model Luna
```

Worker runs carry an attempt number, heartbeat, last meaningful progress, and bounded run history. `task resumable` performs bounded lifecycle reconciliation before returning candidates: a worker with no meaningful progress for the configured stall window is marked `stalled`; a missing heartbeat past the crash window is reclaimed as `crashed`. Repeated crashes open the worker circuit breaker. Use `task recover` after resolving a crash; use `--force true` only when an operator intentionally overrides an open breaker.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task reconcile --id <taskId>
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task recover --id <taskId> --actor codex --actorLabel Codex --model Luna --message "checkpointから再開"
```

Do not add a short-period global heartbeat poller. Ordinary reconciliation is on-demand / next-execution work, and internal execution Tasks use event-driven stdout/stderr stall timers. The optional Codex continuation path is a bounded exception: the existing DevSpace watchdog checks active Work Tasks no more often than the configured continuation sweep (default 60 seconds), with bounded candidate and execution counts.

## Checkpoint and timeout continuation

Long work must not rely on chat text as the only progress store. Save a structured checkpoint at meaningful phase boundaries and before operations likely to consume most of an execution slice.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task checkpoint --id <taskId> --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol" --lastCompletedStep "ソース修正完了" --nextStep "Unityローカル検証" --workspacePath "<checkout>" --branch main --hasUncommittedChanges true --nextActionImpact local_validation --progressSignature "implementation-complete" --progressMade true
```

`nextActionImpact` is mandatory for automatic continuation decisions. Automatic continuation is limited to `read`, `local_write`, `local_test`, `local_validation`, and `local_generation`. External, destructive, billing, production, account, or otherwise confirmation-sensitive actions must not auto-resume.

When an execution boundary is reached, record the cause through `task timeout` rather than using a free-form `task update` only. `timeoutKind` distinguishes `gateway_task`, `command`, `chatgpt_execution`, `dependency`, and `user`. A `chatgpt_execution` timeout must also be disclosed to the user in the next available conversation report; do not present a timeout-stopped Task as if the requested work completed normally.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task timeout --id <taskId> --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol" --timeoutKind chatgpt_execution --elapsedMs 1800000 --nextStep "Unityローカル検証" --workspacePath "<checkout>" --branch main --hasUncommittedChanges true --nextActionImpact local_validation --progressSignature "implementation-complete"
```

The timeout path records the execution timeout, checkpoint, and safety decision. The persistent continuation mode is controlled with `workflow continuation --mode codex|chatgpt|off`. In `codex` mode a safe `chatgpt_execution` timeout stays `paused_timeout` as `Codex引き継ぎ待ち` until the next bounded watchdog sweep starts a DevSpace Codex worker; only then does the resume attempt count advance. In `chatgpt` mode the Task waits for the next host execution and resumes from `resumeContext.nextStep`. In `off` mode it stays paused.

`task resumable` also returns checkpoint-only Tasks where the ChatGPT execution disappeared before `task timeout`, plus active Tasks carrying a Control Center continue request. A continue request without a checkpoint is a host-resume signal only; it is not enough safety metadata to auto-launch a write-capable worker. In `codex` mode, a checkpoint created after the mode was enabled may be delegated after the configured ChatGPT heartbeat grace period (default 10 minutes) if all normal safety checks pass. Explicit `chatgpt_execution` timeouts do not wait for this grace period. Never automatically launch legacy checkpoints created before Codex continuation was enabled.

Codex continuation must use DevSpace agents rather than invoking a provider CLI directly. It may continue safe local writes/tests/validation in the original dirty checkout only after ChatGPT is no longer active, and it must not commit, push, open a PR, perform arbitrary Discord/SNS/email sends, deploy, delete, purchase, or modify account/billing state. AgentTools may independently emit the standardized continuation lifecycle notifications documented in the orchestration spec; the Codex worker itself never receives Discord posting authority. When the Codex worker finishes, return Task ownership to ChatGPT for final review. Persist the DevSpace agent id, continuation attempt, result, changed files, commands, and provider usage snapshot when available.

Automatic continuation is denied when user confirmation is required, another active Task conflicts on the same checkout, the next action is not local/safe, or configured retry/runtime/loop limits are reached. Current defaults are three consecutive timeouts maximum, three auto-resume attempts maximum, four hours cumulative recorded execution time, and repeated-checkpoint loop detection.

Before a push, PR, Discord send, SNS post, production change, deletion, billing/account operation, or any action protected by `AGENTS.md`, set `requiresUserConfirmation=true` and/or an external `nextActionImpact`; do not encode such an action as a safe local impact merely because it was planned earlier. Existing explicit permission must still be revalidated according to the action's normal policy.

For a deliberately manual resume after the required confirmation has been obtained:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task resume --id <taskId> --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol" --force true --phase "再開" --message "確認済みの作業を再開"
```

`force` means the host is intentionally resuming after resolving the blocking condition; it does not grant permission for the protected external/destructive action itself.

A ChatGPT product turn ending cannot be made to spawn a new ChatGPT turn by the local Gateway alone. `chatgpt` mode therefore waits for the next host execution; `codex` mode fills that gap with a bounded DevSpace worker. Control Centerの通常の続行操作はTask状態を変更せず、ChatGPTホスト（Sol系列）へ貼り付ける再開プロンプトを生成するだけである。別の「Codexで続行」が明示された場合のみDevSpace workerを起動し、この手動経路は`implementation` role（GPT-6.1 Sol）を使う。自動`continuation` roleもGPT-6.1 Solを使用し、Astraはユーザーが明示指定した場合だけ利用する。Never claim that either mode bypasses an OpenAI-side turn limit. DevSpace currently exposes Codex quota usage as used/remaining percentage and reset metadata, not exact input/output/cache token counts; label it accordingly in user-visible reporting.

For checkout/non-Git work where a metadata checkpoint is insufficient, capture only the concrete files that need rollback protection:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task snapshot --id <taskId> --paths "relative/file.txt" --label "before risky local refactor"
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task snapshots --id <taskId>
```

Snapshots are bounded file copies under Gateway state. They refuse denied paths such as `.env`, secrets, `node_modules`, and Git objects; they do not snapshot directories or whole repositories. Restore is a protected local write and requires explicit user intent plus the normal confirmation token. Restore overwrites only files present in the snapshot and never deletes files that were absent.

Past Task/Subagent records are searchable through the read-only history index:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js history search --query "水面"
```

The search index is derived state only; Work Task JSON and DevSpace session DB remain the sources of truth.

## Codex review policy

The persistent review mode is inspected or changed with:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js workflow review
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js workflow review --mode codex
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js workflow review --mode chatgpt
```

`codex` means a separate read-only Codex reviewer is preferred after Codex implementation. `chatgpt` disables the extra Codex review and keeps review with the host to reduce Codex token usage. This review setting is independent from `workflow continuation`. Both settings are stored under Gateway `state/` and do not dirty the Git worktree.

## Skill improvement buffering

When the current Task itself exposes a concrete reusable correction to an existing Skill, capture it **while that evidence is fresh** instead of waiting until completion and hoping to remember it. Do not launch an extra LLM turn just to search for Skill improvements.

Buffer the complete proposed Skill content on the active Work Task:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task skillCandidate --id <taskId> --actor chatgpt --actorLabel ChatGPT --skillPath <target SKILL.md> --reason "<durable correction>" --summary "<short summary>" --proposedContentFile <prepared complete SKILL.md>
```

`task.skillCandidate` does not create a visible proposal immediately. It records a bounded candidate tied to the Work Task. `task.complete` / `task.fail` / cancelled completion then flushes buffered candidates through the normal `skill.propose` path with `source=task_completion`, without another model review. If the target Skill changed after buffering, the candidate is marked stale instead of proposing content against the wrong base.

Use direct `skill.propose` for manual/standalone Skill curation that is not naturally tied to an active Work Task.

## Completion

Complete the Task when the user-visible request reaches its requested terminal point. A terminal work Task creates the durable Discord notification event. Buffered Skill improvements are automatically proposalized during completion. If the Task has an enforced Goal Contract, judge it first and include concrete verification evidence.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task judge --id <taskId> --actor chatgpt --goalResult satisfied --summary "完了条件を満たした" --evidence "<test/build/inspection evidence>"
```

Git commands are also completion signals when the user explicitly asks for them:

- `commit` requested: complete the Task immediately after the requested commit succeeds.
- `commit/push` or otherwise push requested: keep the Task active after commit and complete it immediately after the requested push succeeds.
- In the canonical AgentTools repository, committed shared Skill source changes are synchronized automatically by the shared `git-helper`; do not add a separate manual Skill-install step unless auto-sync reports failure.
- Do not wait for the user to additionally say "完了" or "クローズ".
- Keep the Task active only when the user explicitly says the same request continues after commit/push, such as a WIP checkpoint.

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js task complete --id <taskId> --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol" --summary "<result>" --changedFiles "<file1>" --changedFiles "<file2>" --tests "<test result>"
```

For terminal failure use `task fail`. For a user-requested cancellation use `task complete --status cancelled`.

## Reporting rules

Every user-facing progress, interruption, handoff, or completion report for DevSpace-backed development work must make the execution state unambiguous and include:

- **Work status**: say whether the request is complete, has remaining work, is waiting on the user/dependency, or stopped because of an execution timeout.
- **Next work**: state the next concrete step when work remains; when terminal, explicitly say that no further work is required for the current request.
- **DevSpace Workspace ID**: report the `workspaceId` actually used. If more than one Project/worktree was used, pair each ID with its Project path. Never invent an ID from `workspaceRoot` or persist a session-specific ID as a repository constant.
- **Timeout disclosure**: when ChatGPT/host execution time ends before completion, explicitly say that the execution-time limit interrupted the work, whether it is resumable, and what checkpoint/next step remains. If the host was terminated before it could send that notice, disclose it in the first report after execution resumes.

These items are required even when the ordinary prose is very short. They complement Task/Control Center state rather than replacing it.

- In a direct ChatGPT conversation, do not prefix ordinary host-owned updates with `担当: ChatGPT`; that ownership is implicit.
- Explicitly name the worker when Codex is delegated work, when ChatGPT and Codex are working in parallel, or when ownership changes between them.
- If Codex did not participate, the final response does not need a redundant owner label. If Codex did participate, summarize the Codex contribution and the host review/integration split.
- Record concise semantic work, not low-level tool operations.
- One overall Task can contain multiple workers and multiple phases.
- Never include secrets, tokens, cookies, private credentials, or raw sensitive logs in Task messages.
- Standardized terminal and Codex continuation lifecycle notifications are intended for the configured private Discord channel. Do not create extra Discord sends for ordinary intermediate progress.
- If the work exposes a concrete reusable correction to an existing Skill, buffer it immediately with `task.skillCandidate`; terminal Task completion automatically queues the reviewable proposal. Do not spend an extra model turn searching for Skill changes after every Task.
- Task reporting is observability and workflow metadata. If recording fails, continue the requested development work and report the tracking failure rather than treating the user task as failed.
