import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveCommandShell, runWorkspaceCommand } from "./runner.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local command shell", () => {
  test("resolves to an existing platform shell when possible", () => {
    expect(resolveCommandShell()).toBeTruthy();
  });

  test("executes a safe command in the workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "cdc-runner-shell-"));
    tempDirectories.push(workspaceRoot);

    const result = await runWorkspaceCommand({
      workspaceRoot,
      cwd: workspaceRoot,
      command: "echo shell-ok",
      timeoutMs: 10_000,
      confirmedDangerous: false,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("shell-ok");
    expect(result.exitCode).toBe(0);
  });
});
