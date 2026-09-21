---
name: image-bridge
description: Use the shared local image bridge to capture Windows screens/windows, provide local project images to ChatGPT through DevSpace native MCP image content, receive ChatGPT-generated files through DevSpace native artifact download, fall back to validated Base64 transfer when native paths are unavailable, or receive an image as a Blender texture.
---

# Image Bridge

Canonical root: `<AgentToolsRoot>\image-bridge`.

Select the target project with `AGENTTOOLS_WORKSPACE_ROOT` or the PowerShell `-WorkspaceRoot` parameter. Do not infer a project root from the location of the shared tool.

Commands:

- `Capture-ScreenClip.bat`
- `Send-ImageToChatGPT.bat`
- `Receive-ChatGPTImage.bat`
- `Receive-ChatGPTTexture.bat`

For local-to-ChatGPT reference images, prefer the native MCP image path whenever DevSpace exposes `read_image`:

1. `open_workspace` for the project containing the image.
2. `read_image({ workspaceId: "...", path: "relative/path/image.png" })`.
3. Use the returned MCP image content for ChatGPT visual inspection or as the reference for an image-capable workflow such as `image_gen`.

Use `read` for text and `read_image` for PNG, JPEG, WebP, or GIF images. Do not depend on image-extension dispatch inside `read`. This native local-image path has been validated end to end with `image_gen` and is the normal route. `Send-ImageToChatGPT.bat` is fallback when native MCP image input is unavailable or fails.

For ChatGPT-to-local transfers, prefer the native artifact path whenever the MCP host supplies a native file and DevSpace exposes `download_artifact`:

1. `open_workspace` for the target project.
2. `download_artifact({ file: <native file>, workspaceId: "...", path: "relative/path/image.png" })`.
3. Verify size/SHA-256 when useful.

The temporary Windows PR #103 DevSpace build requires `DEVSPACE_ARTIFACTS=1`. Native artifact download is the normal path; Base64 is fallback only.

Use Base64 fallback when `download_artifact` is unavailable, artifact support is disabled, the MCP host cannot supply a native file, the environment is unsupported, or native transfer fails. Do not pass signed download URLs directly to shell commands, do not treat ChatGPT `/mnt/data` paths as Windows-local paths, and do not select Base64 first when native transfer is available.

For Base64 fallback, only reconstruct image bytes that are actually available through the transfer mechanism. Use manifest schema v2 for new transfers. Always include whole-image byte count/SHA-256/content type. Include per-chunk index/normalized encoded length/SHA-256 when doing so does not make the manifest itself an unsafe large tool payload; otherwise rely on whole-image SHA-256 for final integrity. Keep the same transfer ID after an interruption, run `Status`, and resend missing chunks or any chunk identified as corrupt. Identical chunk resend is safe.

Use approximately 12,000 Base64 characters per DevSpace text write as the conservative fallback baseline until a larger end-to-end ChatGPT -> DevSpace size has been repeatedly measured as stable. Do not assume 256 KiB is safe merely because the local receiver can handle it.

Do not resize, recompress, or convert an image merely for transport unless the caller explicitly requests that transformation.

Keep decoded outputs inside the selected workspace. Never write into `.git`. Use `-Force` only when replacing an existing output is explicitly intended. Use `-Cleanup` only after successful validation/finalization; failed transfers should remain available for diagnosis/resume.

When `Receive-ChatGPTTexture.bat` is asked to import the texture into Blender, use the shared `blender-mcp` tool for the Blender step.
