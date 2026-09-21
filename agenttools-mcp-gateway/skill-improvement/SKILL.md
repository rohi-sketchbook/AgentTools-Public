---
name: skill-improvement
description: Record reusable Agent Skill improvements as reviewable proposals instead of silently editing SKILL.md. Use when a completed task exposes a durable correction, repeated procedure, stale instruction, or clear simplification that would improve future work. Do not run an extra LLM review loop just to look for proposals.
---

# Skill Improvement Proposals

Use the AgentTools `skill.*` Gateway actions to queue reusable Skill changes for user review.

## When to propose

Create a proposal only when the current work already produced concrete evidence that an existing `SKILL.md` should change, for example:

- a documented procedure was wrong or stale;
- the same recovery/validation sequence had to be rediscovered;
- a recurring mistake can be prevented with a precise instruction;
- duplicate or contradictory guidance has a clear consolidation;
- the user explicitly asks to improve or curate Skills.

Do not spend an extra model turn asking whether every completed task should produce a Skill change. Do not create proposals for one-off implementation details, transient paths/logs, personal secrets, credentials, or speculative advice.

## Proposal

A proposal stores the current Skill hash, complete proposed content, and a compact diff. It does not modify the Skill.

When an active Work Task naturally exposes the improvement, buffer it immediately on that Task instead of creating the proposal directly:

```text
task.skillCandidate
```

Required inputs are `taskId`/`id`, `actor`, `skillPath`, `reason`, and either `proposedContent` or `proposedContentFile`. Include `skillName`, `summary`, and `proposedBy` when known. The candidate captures the target Skill base hash and complete proposed content while the evidence is fresh. Terminal Task completion automatically flushes buffered candidates through `skill.propose` with `source=task_completion`; no extra LLM review turn is started. If the Skill changed after buffering, the candidate becomes stale rather than proposing against a different base.

For manual or standalone curation that is not tied to an active Work Task, use the structured Gateway action directly:

```text
skill.propose
```

Required inputs are `skillPath`, `reason`, and either `proposedContent` or `proposedContentFile`. Include `skillName`, `summary`, `sourceTaskId`, and `proposedBy` when known.

Equivalent CLI for local operator use:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js skill list --mode active
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js skill get --id <proposalId>
```

Do not stuff the proposal queue with minor wording preferences. One coherent reusable change should normally be one proposal.

## Usage telemetry and Curator

DevSpace records Skill activation counts when a `SKILL.md` is actually read/activated. Inspect this without modifying Skills:

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js skill usage --limit 100
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js skill curate --staleDays 90
```

`skill.curate` is review-only. It identifies stale/unused Skills, duplicate names across Skill roots, high-use Skills worth protecting, and any already-open proposal for the same path. It never edits, deletes, archives, merges, or auto-applies a Skill.

A Curator finding becomes a real change only through the normal reviewed path:

```text
skill.curate -> skill.propose -> skill.approve -> skill.apply
```

Do not infer that a low usage count alone means a Skill is safe to remove. New, specialized, pinned-by-convention, or infrequently needed safety Skills may legitimately have low counts.

## Review lifecycle

Proposal states are:

```text
pending -> approved -> applied
   |          |
   +-> rejected
   +-> stale
```

Approval rechecks the target Skill hash. If the Skill changed after proposal creation, the proposal becomes `stale` and must not overwrite the newer file.

Applying a proposal is a protected local write. `skill.apply` requires:

1. proposal status `approved`;
2. the current Skill hash still matching the proposal base hash;
3. an explicit user-request assertion;
4. the normal AgentTools confirmation token.

Never bypass these checks by writing the proposed content directly after review.

## Control Center

Desktop Control Center is the write-capable review surface: inspect the diff, approve/reject, then explicitly apply an approved proposal.

Web Control Center remains remote read-only. It may display proposal metadata and sanitized diffs, but must not expose approval/apply endpoints unless a separate authenticated write design is explicitly implemented later.
