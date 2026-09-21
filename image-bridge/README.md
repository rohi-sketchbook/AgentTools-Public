# Image Bridge Agent Tool

Canonical root: `<AgentToolsRoot>\image-bridge`

This shared tool handles local screen capture and image transfer between ChatGPT/DevSpace and project workspaces.

## Workspace selection

Project-relative paths are resolved against, in order:

1. `-WorkspaceRoot` when using the PowerShell scripts directly.
2. `AGENTTOOLS_WORKSPACE_ROOT` environment variable.
3. The current working directory.

Decoded outputs must stay inside the selected workspace and cannot target `.git`.

## Commands

- `Capture-ScreenClip.bat`
- `Send-ImageToChatGPT.bat`
- `Receive-ChatGPTImage.bat`
- `Receive-ChatGPTTexture.bat`

`Receive-ChatGPTTexture.bat -ImportToBlender` delegates the Blender import step to `<AgentToolsRoot>\blender-mcp`.

## Local -> ChatGPT reference-image policy

Use DevSpace native MCP image content as the normal first path when `read_image` is available.

```text
local PNG/JPEG/WebP/GIF
  -> DevSpace read_image
  -> MCP native image content
  -> ChatGPT vision / image_gen reference
```

Typical flow:

1. `open_workspace` for the project containing the image.
2. Call `read_image` with the returned `workspaceId` and a workspace-relative image path.
3. Inspect or describe the returned image when validation is useful, then use that image as the reference for the image-capable workflow.

This path has been validated end to end with a local PNG and `image_gen`. The generated result preserved the source design without reproducing the ChatGPT UI.

Use `read` for text and `read_image` for images. Do not rely on image-extension dispatch inside `read`.

`Send-ImageToChatGPT.bat` and its Base64 preview-transfer path remain available as fallback for environments where native MCP image input is unavailable or fails. Do not choose the Base64 path first when `read_image` works.

## ChatGPT -> local receive policy

Use DevSpace native artifact download as the normal first path when the MCP host provides a native file and the DevSpace server exposes `download_artifact`.

```text
ChatGPT native file
  -> DevSpace download_artifact
  -> target Windows workspace
```

Typical flow:

1. `open_workspace` for the target local project.
2. Call `download_artifact` with the MCP-host-provided native file, the returned `workspaceId`, and an unused workspace-relative destination path.
3. When needed, verify the resulting local file size and SHA-256 using read-only inspection commands.

Conceptual tool call:

```text
download_artifact({
  file: <ChatGPT native file>,
  workspaceId: "...",
  path: "relative/path/image.png"
})
```

For the temporary Windows DevSpace PR #103 build, start DevSpace with `DEVSPACE_ARTIFACTS=1`. The default native artifact limit is 100 MiB per file. `download_artifact` accepts only the native file value supplied by the MCP host; it does not accept arbitrary URLs or local source paths and it refuses unsafe or existing destinations.

Use the Base64 bridge only as a fallback when one or more of these conditions apply:

- the `download_artifact` tool is not available;
- DevSpace artifact support is disabled;
- the MCP host cannot supply the generated file as a native file;
- the current environment does not support native artifact download;
- native artifact transfer fails and a Base64 retry is required.

Transport rules:

- Do not resize, recompress, quantize, or convert an image merely to make transport easier.
- Do not choose Base64 as the first path when native artifact download is available.
- Do not pass signed download URLs directly to Bash/PowerShell as a substitute transport mechanism.
- Do not treat a ChatGPT-side `/mnt/data` path as a Windows-local path.

## Base64 fallback receive protocol

When native artifact download is unavailable or fails, preserve the existing validated Base64 receiver path:

```text
ChatGPT image bytes
  -> Base64
  -> small text chunks through DevSpace.write
  -> manifest.json + chunks/*.b64
  -> Receive-ChatGPTImage.ps1
  -> validated local image
```

Do not assume that an image visible in the ChatGPT UI or under ChatGPT `/mnt/data` is directly readable from DevSpace.

Do not manually concatenate or visually edit Base64 data. Chunk creation and metadata should be generated mechanically from the original image bytes whenever those bytes are available.

### Transfer directory

```text
UserData/Temp/ChatGPTImageBridge/inbox/<transfer-id>/
  manifest.json
  chunks/
    000000.b64
    000001.b64
    ...
```

`transfer-id` must be 1-64 characters using letters, numbers, `.`, `_`, or `-`.

## Manifest v2

New transfers should use schema version 2.

```json
{
  "schemaVersion": 2,
  "transferId": "avatar-booth-reference-20260726",
  "outputPath": "references/reference.png",
  "contentType": "image/png",
  "width": 1672,
  "height": 941,
  "decodedBytes": 1521723,
  "sha256": "whole-image-sha256",
  "chunkCount": 123,
  "chunks": [
    {
      "index": 0,
      "encodedLength": 12000,
      "sha256": "normalized-base64-chunk-sha256"
    }
  ]
}
```

For v2, `chunks` metadata is optional but strongly recommended when it can be transported safely. Each chunk hash is the SHA-256 of the normalized ASCII Base64 payload for that chunk after whitespace removal. If the first chunk contains a `data:...;base64,` prefix, the prefix is excluded from `encodedLength` and the chunk hash.

Do not create a very large single `manifest.json` merely to carry thousands of per-chunk hashes. When `chunks` metadata is omitted, Status still reports missing/extra chunks and validates basic Base64 syntax, while Finalize still enforces decoded byte count and the whole-image SHA-256. In that fallback mode corruption is detected at Finalize rather than pinpointed to one chunk.

`width` and `height` are metadata describing the original image and should be recorded by the sender when available. The receiver currently validates the image signature, byte count, content type, extension, whole-image SHA-256, and any supplied chunk metadata; it does not decode every image format far enough to verify dimensions.

Manifest v1 remains readable for existing transfers.

## Resume and Status

Use:

```bat
Receive-ChatGPTImage.bat -Action Status -TransferId TRANSFER_ID
```

For automation/resume logic, add `-Json` to receive one compact machine-readable status object containing `state`, `missing`, `corrupt`, `extra`, chunk counts, integrity mode, and output metadata.

Status reports:

```text
Schema: 2
Chunks: 87 / 123
Missing: 87-122
Corrupt: none
Extra: none
ChunkIntegrity: per-chunk-sha256
State: INCOMPLETE
```

States:

- `MISSING`: transfer directory does not exist.
- `MANIFEST_MISSING`: chunks exist but no manifest is available.
- `INCOMPLETE`: expected chunks are missing.
- `CORRUPT`: a v2 chunk length/hash/Base64 check failed, an unexpected chunk exists, or an extra index exists.
- `READY`: all required chunks are present and pass pre-finalize checks.

A stopped transfer should keep the same `transferId`. Re-send only missing or corrupt chunks and run `Status` again. Writing the same chunk contents again is safe. When per-chunk metadata is present, writing different contents to the same index is detected immediately by Status. Without per-chunk metadata, the whole-image SHA-256 still prevents a corrupted output from being published.

## Finalize

```bat
Receive-ChatGPTImage.bat -Action Finalize -TransferId TRANSFER_ID -Cleanup
```

Finalize performs these checks before publishing the output:

- manifest identity and supported schema
- contiguous/expected chunks
- v2 per-chunk encoded length and SHA-256 when supplied
- Base64 character and padding validity
- decoded byte limit
- decoded byte count
- expected total Base64 character count derived from `decodedBytes` (detects truncated chunk bodies even when all chunk files exist)
- whole-image SHA-256
- PNG/JPEG/WebP/GIF signature
- manifest content type
- output extension
- allowed workspace root and `.git` exclusion
- existing output protection unless `-Force` is explicit

Base64 decoding is streamed chunk-by-chunk into a unique `.partial.<guid>` file in the output directory. The whole Base64 payload and whole decoded image are not retained simultaneously in memory. SHA-256 is calculated while decoded bytes are written.

The partial file is atomically moved/replaced only after validation succeeds. Transfer data is removed by `-Cleanup` only after the validated output has been published. Failed transfers keep their manifest/chunks for diagnosis and resume.

## Chunk size policy

Do not treat a larger chunk as an optimization by itself.

Past ChatGPT -> DevSpace transfers have failed or stalled while sending long Base64 payloads. A DevSpace tool call also has serialization and model/tool argument overhead before the data reaches the local PowerShell receiver.

Until an end-to-end size probe establishes a larger stable value, use approximately **12,000 Base64 characters per DevSpace.write call** as the conservative operational baseline. Increase this only from measured ChatGPT -> DevSpace results, with safety margin; do not assume the older 256 KiB documentation value is safe for a single tool call.

The receiver does not enforce 12,000 characters because older transfers and future measured configurations may use different chunk sizes.

## Image fidelity

Transport must not silently change the image.

- PNG stays PNG.
- JPEG stays JPEG.
- WebP stays WebP.
- Do not resize, recompress, quantize, or convert formats merely to make transport easier unless the caller explicitly requests that transformation.

This is especially important for reference images used by `img2blender` or image-comparison workflows.

## Tests

Run the built-in self-test:

```bat
Receive-ChatGPTImage.bat -Action SelfTest
```

Run the regression suite:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <AgentToolsRoot>\image-bridge\tests\Test-Receive-ChatGPTImage.ps1
```

The suite currently covers v2 incomplete transfer reporting, machine-readable JSON Status, resume, identical resend, changed-chunk corruption detection, valid finalize/cleanup, whole-image SHA failure, Content-Type failure, allowed-root enforcement, v1 compatibility, streaming 1 MiB / 5 MiB payload restoration, and the historical failure shape where all v1 chunk files exist but one chunk body is truncated.
