---
name: hyperframes-video
description: "Create, edit, validate, preview, and render local programmatic videos with HyperFrames in the shared AgentTools environment. Use when the user asks DevSpace to make a HyperFrames video, motion graphic, development-log video, slideshow, or to port a Remotion composition to HyperFrames. Default root: <AgentToolsRoot>\\hyperframes."
---

# HyperFrames Video

Use this skill for local HyperFrames video production.

## Environment

- Shared root: `<AgentToolsRoot>\hyperframes`
- Maintained CLI baseline: **HyperFrames 0.8.23** (updated 2026-09-02).
- Node.js 24.x and FFmpeg are installed.
- Chrome Headless Shell is installed through HyperFrames.
- Use `hf-local.cmd` for HyperFrames CLI commands. It sets `HYPERFRAMES_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` for every invocation.
- Keep rendering local by default.
- Active render projects should pin `hyperframes@0.8.23`; historical one-off projects may intentionally preserve an older exact pin for reproducible renders.

## Allowed official skills

The maintained HyperFrames skill set for this environment is limited to:

- `hyperframes`
- `hyperframes-cli`
- `hyperframes-core`
- `hyperframes-animation`
- `hyperframes-creative`
- `hyperframes-keyframes`
- `hyperframes-registry`
- `media-use`

Do not automatically install missing optional HyperFrames workflow skills such as `remotion-to-hyperframes`, `figma`, `general-video`, `motion-graphics`, `music-to-video`, or `talking-head-recut`. Add one only when a user request actually requires that workflow.

## Privacy and external-service policy

- Do not sign in to HeyGen.
- Do not install or invoke the HeyGen CLI for media generation/search unless the user explicitly authorizes the service after being told what will be sent externally and whether usage can be metered.
- Do not use HyperFrames cloud publishing, cloud generation, paid APIs, external TTS, stock media services, or avatar generation by default.
- Prefer existing local assets, ChatGPT image generation transferred through Image Bridge, local fonts, and FFmpeg.
- Never use `curl ... | bash`, remote shell bootstrap installers, or equivalent pipe-to-shell installation patterns.

## Core commands

From `<AgentToolsRoot>\hyperframes`:

- Doctor: `hf-local.cmd doctor`
- Lint: `hf-local.cmd lint .`
- Check: `hf-local.cmd check`
- Preview/Studio: `hf-local.cmd preview`
- Render: `hf-local.cmd render`

When a project pins a HyperFrames version, follow the official HyperFrames skill guidance for version checking and verification, but invoke CLI operations through `hf-local.cmd` where applicable.

## Update procedure

- Check the CLI baseline with `hf-local.cmd --version` and npm latest before changing a pin.
- Check installed official skills with `hf-local.cmd skills check --json`.
- HyperFrames skill updates can expand a partial install with newly introduced core or workflow skills. Preserve the maintained allow-list above: after updating, run `hf-local.cmd skills check --json`, keep the approved skills current, and do not retain newly added or optional skills unless explicitly approved.
- After a CLI/pin update, run the project's `check` command and at least one local render before treating the update as validated.
- Cloud Plan v2 is the 0.8.x default. AWS Lambda / GCP Cloud Run deployments must be version-aligned before SDK callers are upgraded; this shared environment remains local-render-first.

## Creation rules

- Read the official `hyperframes` entry skill and `hyperframes-core` contract before authoring a composition.
- Keep compositions deterministic and frame-seekable.
- Use local project-relative media paths.
- Prefer 1920x1080 / 30fps for ordinary landscape output and 1080x1920 / 30fps for vertical shorts unless the user specifies otherwise.
- For Remotion ports, use the official `remotion-to-hyperframes` skill and preserve the original output until the HyperFrames version is verified.

## Verification

Before declaring a video complete:

1. Run lint/check as appropriate.
2. Render locally.
3. Confirm the output file exists and is non-zero size.
4. Report the exact output path, resolution, FPS, duration, and codec when known.
