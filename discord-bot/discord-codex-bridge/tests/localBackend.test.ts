import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalBackend } from "../src/backends/localBackend.ts";

const backend = new LocalBackend();

test("LocalBackend handles pwd/ls/log without AI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-local-backend-test-"));
  await writeFile(path.join(root, "hello.txt"), "hello", "utf8");
  await mkdir(path.join(root, "logs"));
  await writeFile(path.join(root, "logs", "app.log"), "line1\nline2\nlatest", "utf8");

  const pwd = await backend.execute({ text: "pwd", workspaceRoot: root, cwd: root }, {});
  assert.equal(pwd.status, "completed");
  assert.equal(pwd.text, path.resolve(root));

  const ls = await backend.execute({ text: "ファイル一覧見せて", workspaceRoot: root, cwd: root }, {});
  assert.equal(ls.status, "completed");
  assert.match(ls.text ?? "", /hello\.txt/);
  assert.match(ls.text ?? "", /logs/);

  const log = await backend.execute({ text: "ログ表示", workspaceRoot: root, cwd: root }, {});
  assert.equal(log.status, "completed");
  assert.match(log.text ?? "", /logs[\\/]app\.log/);
  assert.match(log.text ?? "", /latest/);
});

test("LocalBackend accepts a junction/symlink that resolves inside workspaceRoot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-local-junction-target-"));
  const aliasParent = await mkdtemp(path.join(os.tmpdir(), "discord-local-junction-alias-"));
  const alias = path.join(aliasParent, "workspace-alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");

  const result = await backend.execute({ text: "pwd", workspaceRoot: root, cwd: alias }, {});
  assert.equal(result.status, "completed");
  assert.equal(result.text, await realpath(root));
});

test("LocalBackend refuses cwd outside workspaceRoot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-local-root-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "discord-local-outside-test-"));
  const result = await backend.execute({ text: "ls", workspaceRoot: root, cwd: outside }, {});
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /workspaceRoot外/);
});

test("LocalBackend lists the Avatar Dev Loop queue through the fixed Gateway CLI runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-local-autodev-test-"));
  const autoDevBackend = new LocalBackend(async () => JSON.stringify({
    ok: true,
    issues: [
      { id: "issue-new", status: "new", title: "未処理課題", risk: "medium", origin: "manual", requestMode: "fix", claimId: null },
      { id: "issue-fixing", status: "fixing", title: "修正中課題", risk: "low", origin: "detected", requestMode: null, claimId: "claim-1", assignedTo: "worker-a" },
      { id: "issue-done", status: "completed", title: "完了課題", risk: "low", origin: "detected" },
    ],
  }));

  const result = await autoDevBackend.execute({ text: "/local autodev list", workspaceRoot: root, cwd: root }, {});
  assert.equal(result.status, "completed");
  assert.match(result.text ?? "", /Avatar Dev Loop課題キュー: 2件/);
  assert.match(result.text ?? "", /issue-new/);
  assert.match(result.text ?? "", /issue-fixing/);
  assert.doesNotMatch(result.text ?? "", /issue-done/);
  assert.match(result.text ?? "", /claimed:worker-a/);
});

test("LocalBackend rejects arbitrary shell text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-local-allowlist-test-"));
  const result = await backend.execute({ text: "rm -rf anything", workspaceRoot: root, cwd: root }, {});
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /許可済みコマンドのみ/);
});
