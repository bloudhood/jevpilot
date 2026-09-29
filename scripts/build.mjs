import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

await rm("dist", { recursive: true, force: true });
const child = spawn(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  {
    stdio: "inherit",
  },
);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
});
process.exitCode = code;
