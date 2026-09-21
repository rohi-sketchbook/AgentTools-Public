import assert from "node:assert/strict";
import test from "node:test";

import { isUpstreamControlCommand, normalizeUpstreamControlCommand } from "../src/integration.ts";

test("upstream bot control commands never enter ChatGPT auto routing", () => {
  const commands = [
    "reload restart confirm",
    "/reload mode:restart confirm:true",
    "clear all confirm",
    "sync status",
    "/sync-status",
    "__cdc_schedule abc",
    "schedule list",
    "devlog run",
    "__cdc_new_chat abc",
    "/chat-new name:test",
    "archive confirm",
    "model gpt-5.4",
    "fast",
    "task",
    "mode default",
    "/codex-mode mode:fast",
    "help",
    "maintenance",
  ];

  for (const command of commands) {
    assert.equal(isUpstreamControlCommand(command), true, command);
  }
});

test("typed reload slash command is normalized to upstream control syntax", () => {
  assert.equal(
    normalizeUpstreamControlCommand("/reload mode:restart confirm:true"),
    "reload restart confirm",
  );
  assert.equal(
    normalizeUpstreamControlCommand("/reload mode:commands"),
    "reload commands",
  );
  assert.equal(
    normalizeUpstreamControlCommand("/reload restart confirm"),
    "reload restart confirm",
  );
  assert.equal(normalizeUpstreamControlCommand("/local pwd"), null);
});

test("normal work requests are not mistaken for upstream bot control", () => {
  const requests = [
    "READMEを調査して",
    "/ask 現在の変更点を調べて",
    "/local pwd",
    "git status",
    "このバグを直して",
  ];

  for (const request of requests) {
    assert.equal(isUpstreamControlCommand(request), false, request);
  }
});
