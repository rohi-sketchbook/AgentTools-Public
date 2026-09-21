# Special Development Log Preview Pipeline

This job creates an unpublished preview only. The brief supplied in `SPECIAL_BRIEF_CONTENT` is authoritative. Do not replace it with daily Git history or another topic.

## Inputs

- `SPECIAL_SLUG`
- `RUN_DATE_JST`
- `SITE_ROOT`
- `VIEWER_ROOT_READ_ONLY`
- `SPECIAL_BRIEF_PATH`
- `REFERENCE_IMAGE_ATTACHED_WITH_CODEX_IMAGE_INPUT`: authoritative visual reference for the main subject.
- `LOGO_REFERENCE_ATTACHED_WITH_CODEX_IMAGE_INPUT`: authoritative logo/brand reference.
- `PUBLICATION_ALLOWED=false`

Do not assume fixed user names, character names, drive letters, repository owners, or public URLs.

## Required outputs

Under the work directory prepared by the Runner, create:

- `article.md`
- `image_prompt.txt`
- `generated.png`
- `special-status.json`

The outer Runner creates `draft.html` after validating these files.

## Image requirements

Create exactly a 2x2 four-panel comic.

- Match the attached main-subject reference.
- Match the attached logo reference when the logo is shown.
- Do not introduce an unknown replacement main character.
- Do not turn the result into a poster, key visual, or single-panel illustration.
- Keep Japanese text legible when Japanese is requested by the brief.
- Use visual review and regenerate when any required QA item fails.
- Limit retries to three image attempts.

## Status contract

Write `special-status.json` with at least:

```json
{
  "schema_version": 1,
  "slug": "<SPECIAL_SLUG>",
  "date": "<RUN_DATE_JST>",
  "stage": "image_validated",
  "article_ready": true,
  "prompt_ready": true,
  "image_ready": true,
  "draft_ready": false,
  "published": false,
  "image_attempts": 1,
  "qa": {
    "exactly_four_panels": true,
    "reference_image_match": true,
    "logo_reference_match": true,
    "no_unknown_main_character": true,
    "no_poster_layout": true,
    "japanese_legible": true
  },
  "error": null
}
```

Use the actual retry count for `image_attempts`. Every QA field must be true before returning. Never commit, push, publish, or update public indexes in this special-preview job.
