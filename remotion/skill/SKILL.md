---
name: remotion-video
description: "Create, edit, preview, and render programmatic videos with Remotion in the shared local AgentTools environment. Use when the user asks DevSpace to make a video, motion graphic, development-log video, slideshow, captioned clip, or Remotion composition. Default root: <AgentToolsRoot>\\remotion."
---

# Remotion Video

Use this skill for local programmatic video creation with Remotion.

## Environment

- Shared root: `<AgentToolsRoot>\remotion`
- Maintained Remotion baseline: **4.0.514** (updated 2026-08-21).
- React remains pinned at **19.1.1** and TypeScript at **5.9.2** for this update; do not bundle unrelated framework/toolchain upgrades into a Remotion patch update.
- Node.js is already installed.
- On this Windows machine, prefer `npm.cmd` and `npx.cmd` instead of `npm` / `npx` because PowerShell execution policy may block `npm.ps1`.
- Remotion is installed locally in this project. Do not install another global copy unless explicitly requested.
- Keep generated videos under `out\` unless the target project requires a different output directory.

## Core commands

From `<AgentToolsRoot>\remotion`:

- Type check: `npx.cmd tsc --noEmit`
- Open Studio: `npm.cmd run studio`
- Render smoke test: `npm.cmd run render:test`
- Render a composition explicitly: `npx.cmd remotion render src/index.ts <CompositionId> out\<name>.mp4 --codec=h264`
- Verify installed package alignment: `npx.cmd remotion versions`

## Creation rules

- Prefer reusable React/TypeScript compositions with data passed as props.
- Animate with `useCurrentFrame()`, `interpolate()`, `spring()`, and Remotion sequencing primitives. Do not rely on ordinary CSS transitions that are not frame-driven.
- Use `staticFile()` or explicit project-relative asset paths for local assets.
- Keep videos deterministic: the same props and assets should render the same output.
- For repeated workflows such as development logs, create a reusable template rather than rewriting the whole composition each run.
- Use 1920x1080 / 30fps for ordinary landscape output unless the user specifies otherwise.
- Use 1080x1920 / 30fps for vertical shorts unless the user specifies otherwise.

## External effects and cost safety

- Remotion rendering itself must stay local by default.
- Do not use Remotion Lambda, paid TTS, paid stock media, paid APIs, or cloud rendering unless the user explicitly authorizes the service and cost.
- Do not upload or publish rendered files unless the user explicitly requests the destination/action.

## Integration

- ChatGPT-generated images may be transferred through the shared Image Bridge.
- Blender renders may be used as source clips or stills.
- Discord upload is a separate explicit action; use the Discord Bot skill only when the user asks to post/send the video.

## Update procedure

When updating Remotion:

1. Keep `remotion` and `@remotion/cli` on the same exact version.
2. Regenerate/apply the matching lockfile dependency graph; Remotion 4.0.514 pulls the matching 4.0.514 packages and Mediabunny 1.55.1.
3. Run `npm.cmd ci` so `node_modules` matches `package-lock.json`.
4. Run `npx.cmd remotion versions`, `npx.cmd tsc --noEmit`, and `npm.cmd run render:test`.
5. Do not update React or TypeScript at the same time unless that upgrade is separately requested and validated.

## Verification

Before declaring a video complete:

1. Run TypeScript checking.
2. Render the requested composition locally.
3. Confirm the output file exists and is non-zero size.
4. Report the exact output path, resolution, FPS, duration, and codec when known.
