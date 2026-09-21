# Development Log Pipeline

This is an unattended local development-log generation job. Do not stop for confirmation. Use the values supplied in `RUN_CONTEXT` as authoritative.

## Inputs

- `RUN_DATE_JST`: publication date.
- `SITE_ROOT`: writable site repository.
- `VIEWER_ROOT_READ_ONLY`: read-only source project used to identify recent development work.
- `REFERENCE_IMAGE_ATTACHED_WITH_CODEX_IMAGE_INPUT`: attached visual reference for the recurring main character or brand subject.
- The exact `status.json` schema is appended by the outer Runner.

Do not assume any fixed drive letter, user name, project name, repository owner, character appearance, or public URL beyond these inputs.

## Stage 1 — Select and write the entry

Inspect recent source-project changes and choose one coherent development topic for the date. Prefer concrete implementation work over vague progress summaries.

Create or update exactly these publication files:

1. `docs/devlog/<RUN_DATE_JST>.html`
2. `docs/assets/images/devlog-<RUN_DATE_JST>-comic.png`
3. `docs/devlog/index.html`
4. `docs/index.html`

Keep the article readable on desktop and mobile. Preserve the existing site's structure and visual conventions instead of replacing them wholesale.

## Stage 2 — Create and validate the image

Create a 2x2 four-panel comic image that supports the selected topic.

- Use the attached reference image as the authoritative visual reference for the recurring subject.
- Keep the subject visually consistent across panels.
- Do not invent a different main character when the reference is clear.
- Keep text concise and legible.
- Avoid poster-style layouts when the site expects a four-panel comic.
- Verify the final image dimensions and file path expected by the existing site.

## Stage 3 — Validate the publication set

Before returning:

- Validate HTML structure and local links.
- Ensure placeholders and temporary text are absent.
- Ensure article date/title/index entries agree.
- Ensure responsive image CSS remains present.
- Ensure OGP/share metadata required by the existing site remains present.
- Inspect the Git diff and confirm publication scope is exactly the four files listed above.
- Scan the publication diff for obvious tokens, credentials, local absolute paths, or private data.

Write `.devlog-work/<RUN_DATE_JST>/status.json` using the exact schema appended in `RUN_CONTEXT`.

The status must be ready for the outer Runner with:

- `article_ready=true`
- `prompt_ready=true`
- `image_ready=true`
- `published=false`
- `stage="validated"`
- `error=null`
- every required validation flag set to `true`
- `node_runner_handoff.ready=true`
- `node_runner_handoff.paths` exactly matching the four publication files above

Do not commit, push, publish, or broaden the Git scope yourself. The outer Runner performs publication only after validating the machine contract.
