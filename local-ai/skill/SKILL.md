---
name: local-ai
description: Operate the local Stability Matrix and ComfyUI through the guarded AgentTools Local AI adapter. Use for checking local image/video AI availability, listing ComfyUI models/workflows, starting ComfyUI through Stability Matrix, planning/running registered ComfyUI workflows, interrupting AgentTools-owned generations, or freeing ComfyUI VRAM.
---

# Local AI

Canonical root: `<AgentToolsRoot>\local-ai`.

External Stability Matrix runtime: use `stabilityMatrixRoot` from the merged Local AI configuration.

## Preferred workflow

1. Inspect first:
   `node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi status`
2. Inspect available workflows:
   `node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi workflows`
3. If a model list is needed and ComfyUI is online:
   `node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi models --folder <folder>`
4. If ComfyUI is offline and the user request requires generation, plan startup with `localAi start`, then use the normal `task.run` confirmation/execution path.
5. Plan generation with `localAi generate --workflow <registered-id> ...`; then execute through `task.run` only when the user request authorizes the generation and Gateway safety permits it.
6. Read generated files from the task output path. Use `image-bridge` or the Discord skill when the user asks to inspect or deliver them.

## Safety / ownership

- Do not add the configured Stability Matrix runtime root to generic AgentTools filesystem allowed roots merely to simplify access.
- Do not recursively scan the shared Models tree. Prefer ComfyUI `/models/{folder}`.
- Do not use Stability Matrix GUI automation for normal inference.
- Do not create a permanent ComfyUI polling daemon.
- `localAi.interrupt` may only interrupt the currently running prompt when its persisted job record says it is AgentTools-owned and still running.
- Do not stop Stability Matrix or ComfyUI merely because a job finished; a human may still be using the runtime.
- Use `localAi.free` only with the normal confirmation path and only while the queue is empty.
- Installing/updating packages, custom nodes, models, or Stability Matrix itself is outside the current automatic adapter. Ask before adding such capabilities because they modify the AI environment and may involve network/download risk.

## Workflow format

Only registered ComfyUI API-format workflows are executable. GUI `nodes`/`links` workflow files are detected for inventory but are not sent directly to `/prompt`.

Each registered workflow lives under:

`<AgentToolsRoot>\local-ai\workflows\<id>\`

and contains `manifest.json` plus an API workflow JSON. The manifest maps semantic values such as `prompt`, `seed`, `steps`, `width`, and `height` to concrete node inputs.

For registered edit workflows with `inputFiles`, place source images under `<AgentToolsRoot>\local-ai\input\` and pass their relative names through `paramsJson` (for example `inputImage`, `referenceImage2`, `referenceImage3`). The runner stages only those files into ComfyUI input and removes the staged copies after a terminal generation result.

For fast local video generation on the RTX 3080-class setup, `ltx-2-3-distilled-ja` / `ltx-2-3-distilled-ja-i2v` remain available with the LTX-2.3 Distilled 1.1 Q2_K GGUF 640x384, 97-frame, 24 fps, CFG 1.0, fixed 8-step baseline. When using LTX from a Japanese request, preserve intent while turning it into a concise chronological LTX prompt before invoking the workflow. Do not add a second-stage latent upscale unless the user explicitly prioritizes quality over generation speed.\n\nFor Wan2.2 TI2V 5B Turbo, use `wan2-2-ti2v-5b-turbo-ja` for T2V and `wan2-2-ti2v-5b-turbo-ja-i2v` for I2V. The RTX 3080 10GB baseline is 832x480, 81 frames, 24 fps, 4 steps, CFG 1.0, Euler + simple, SD3 shift 8, and latent multiplier 0.8. I2V must receive `inputImage` from `local-ai/input/` through the existing staging mechanism. For Japanese requests, preserve user intent but produce a concise English Wan prompt organized around subject, action, camera motion, scene, lighting, and chronological motion before invoking the workflow.
