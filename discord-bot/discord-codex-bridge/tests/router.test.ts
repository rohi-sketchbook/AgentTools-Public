import assert from "node:assert/strict";
import test from "node:test";

import { splitDiscordMessage } from "../src/integration.ts";
import { autoSelectBackend, routeMultiBackendMessage } from "../src/router.ts";

test("auto routing prioritizes Local for simple operations", () => {
  assert.equal(autoSelectBackend("git status"), "local");
  assert.equal(autoSelectBackend("ファイル一覧"), "local");
  assert.equal(autoSelectBackend("pwd"), "local");
  assert.equal(autoSelectBackend("git diff見せて"), "local");
  assert.equal(autoSelectBackend("ログ一覧見せて"), "local");
  assert.equal(autoSelectBackend("autodev list"), "local");
  assert.equal(autoSelectBackend("現在の課題キューを一覧表示"), "local");
});

test("auto routing sends reasoning work to ChatGPT queue", () => {
  assert.equal(autoSelectBackend("このバグの原因を調査して修正方針を考えて"), "chatgpt");
  assert.equal(autoSelectBackend("UnityのSceneを調査して"), "chatgpt");
});

test("Codex is selected only when explicitly named", () => {
  assert.equal(autoSelectBackend("Codexでこのプロジェクトを調査して"), "codex");
  assert.deepEqual(
    routeMultiBackendMessage({ content: "@codex READMEを調査して", defaultBackend: "auto" }),
    { kind: "backend", backend: "codex", text: "READMEを調査して", explicit: true },
  );
});

test("Discord replies are split below the platform message limit", () => {
  const text = Array.from({ length: 80 }, (_, index) => `${index + 1}. 長い課題キュー項目 ${"詳細".repeat(20)}`).join("\n");
  const chunks = splitDiscordMessage(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
  assert.match(chunks[0]!, /^1\./);
  assert.match(chunks.at(-1)!, /80\./);
});

test("slash-compatible text routes", () => {
  assert.deepEqual(
    routeMultiBackendMessage({ content: "/bridge-status", defaultBackend: "auto" }),
    { kind: "status" },
  );
  assert.deepEqual(
    routeMultiBackendMessage({ content: "/backend local", defaultBackend: "auto" }),
    { kind: "set-backend", backend: "local" },
  );
  assert.deepEqual(
    routeMultiBackendMessage({ content: "/ask 現在の変更点を調べて", defaultBackend: "auto" }),
    { kind: "backend", backend: "chatgpt", text: "現在の変更点を調べて", explicit: true },
  );
  assert.deepEqual(
    routeMultiBackendMessage({ content: "/local git status", defaultBackend: "auto" }),
    { kind: "backend", backend: "local", text: "git status", explicit: true },
  );
});
