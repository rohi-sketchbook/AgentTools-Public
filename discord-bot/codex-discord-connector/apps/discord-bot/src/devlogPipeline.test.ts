import { describe, expect, test } from "vitest";
import { parseDevlogCompletionLine } from "./devlogPipeline.js";

describe("devlog pipeline completion parsing", () => {
  test("accepts only a successful published completion", () => {
    expect(parseDevlogCompletionLine(
      "DEVLOG_PIPELINE_FINISHED DATE=2026-08-07 EXIT=0 STAGE=published PUBLISHED=true\n",
    )).toEqual({
      succeeded: true,
      exitCode: 0,
      stage: "published",
      published: true,
    });
  });

  test("marks validation failure as unsuccessful", () => {
    expect(parseDevlogCompletionLine(
      "DEVLOG_PIPELINE_FINISHED DATE=2026-08-07 EXIT=1 STAGE=validation_failed PUBLISHED=false\n",
    )).toEqual({
      succeeded: false,
      exitCode: 1,
      stage: "validation_failed",
      published: false,
    });
  });

  test("uses the last completion marker", () => {
    expect(parseDevlogCompletionLine([
      "DEVLOG_PIPELINE_FINISHED DATE=2026-08-07 EXIT=1 STAGE=publish_failed PUBLISHED=false",
      "DEVLOG_PIPELINE_FINISHED DATE=2026-08-07 EXIT=0 STAGE=published PUBLISHED=true",
    ].join("\n"))?.succeeded).toBe(true);
  });
});
