import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const marker = ".jevpilot-owner.json";

// Chrome can hold files of a profile or download directory for a moment after it exits (EBUSY / EPERM on
// Windows); fs.rm retries those errors itself when asked to.
export async function removeTempDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function createOwnedTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await writeFile(
      join(directory, marker),
      JSON.stringify({ pid: process.pid, created: new Date().toISOString() }),
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function sweepStaleTempDirs(
  root: string,
  isAlive: (pid: number) => boolean,
): Promise<number> {
  let removed = 0;
  for (const name of await readdir(root)) {
    if (!name.startsWith("jevpilot-")) continue;
    const directory = join(root, name);
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      if (!(await lstat(join(directory, marker))).isFile()) continue;
      const owner: unknown = JSON.parse(await readFile(join(directory, marker), "utf8"));
      if (!owner || typeof owner !== "object" || !("pid" in owner)) continue;
      const pid = owner.pid;
      if (
        !Number.isInteger(pid) ||
        typeof pid !== "number" ||
        pid <= 0 ||
        pid === process.pid ||
        isAlive(pid)
      )
        continue;
      await rm(directory, { recursive: true, force: true });
      removed++;
    } catch {
      // Unknown or busy entries are left untouched.
    }
  }
  return removed;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
