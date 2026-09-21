# img2threejs security review - 2026-07-26

Reviewed checkout:

- Repository: `https://github.com/img2threejs/img2threejs.git`
- Commit: `ffe0ace9cfcb8686fd8473371ccbf0ffc2e906e0`

## Result

No evidence of malicious or obviously compromised behavior was found in the reviewed checkout.

This is a source review, not a formal security certification.

## Checked areas

- No bundled executable files were found in the checkout.
- No Git hooks were installed by the repository.
- No Git submodules are configured.
- No Python `eval()` or runtime Python `exec()` usage was found in the production code reviewed.
- No `subprocess(..., shell=True)` usage was found.
- No obvious credential/token/cookie collection logic was found.
- No registry/startup/task-scheduler persistence logic was found.
- `forge/requirements.txt` declares no third-party Python dependencies; the forge scripts are designed around Python 3.10+ standard library functionality.

## External process execution

Observed subprocess use is narrowly scoped:

- macOS `sips` for optional image conversion.
- `Source2Viewer-CLI` for optional extraction from a user's local CS2 VPK installation.

Arguments are passed as argument arrays rather than shell command strings.

## Network access

`forge/stage1_intake/fetch_cs2_metadata.py` can perform explicit network access when invoked with remote metadata/image options:

- `urllib.request.urlopen(index_url, timeout=30)`
- `urllib.request.urlretrieve(imageUrl, target)`

This is not needed by the img2blender image-reference-to-Blender path and should not be invoked automatically by the shared img2blender tool.

## Test note

The upstream checkout compiles with Python 3.12.10. The upstream test suite currently has Windows-specific failures/errors involving cp932 text encoding and symlink privilege behavior, plus some apparent gate/test drift. Those failures are tracked separately from security review and are not currently evidence of malicious behavior.

## img2blender policy

- Keep upstream isolated under `tools/img2threejs`.
- Do not patch upstream by default.
- Do not automatically invoke upstream network-fetch functionality.
- Do not automatically invoke external Source2Viewer extraction.
- Prefer PNG inputs for the Windows lab path.
