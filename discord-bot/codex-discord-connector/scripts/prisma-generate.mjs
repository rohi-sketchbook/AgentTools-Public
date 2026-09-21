import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaPackageRoot = path.dirname(require.resolve("prisma/package.json"));
const prismaCli = path.join(prismaPackageRoot, "build", "index.js");
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL?.trim() || "file:./dev.sqlite",
};

const result = spawnSync(process.execPath, [prismaCli, "generate", "--schema", "prisma/schema.prisma"], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
