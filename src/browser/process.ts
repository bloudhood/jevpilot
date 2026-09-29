import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { BrowserLaunchError } from "./errors.ts";

export type Spawn = typeof nodeSpawn;
export type ProcessDeps = {
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function spawnBrowser(
  executable: string,
  args: string[],
  deps: ProcessDeps = {},
): ChildProcess {
  return (deps.spawn ?? nodeSpawn)(executable, args, {
    shell: false,
    stdio: "ignore",
    detached: (deps.platform ?? process.platform) !== "win32",
    ...(deps.env ? { env: deps.env } : {}),
  } satisfies SpawnOptions);
}

export async function stopBrowser(child: ChildProcess, deps: ProcessDeps = {}): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) throw new BrowserLaunchError("browser process has no PID");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if ((deps.platform ?? process.platform) === "win32") {
    const killer = (deps.spawn ?? nodeSpawn)("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      killer.once("exit", () => resolve());
      killer.once("error", reject);
    });
    await exited;
    return;
  }
  const kill = deps.kill ?? process.kill;
  try {
    kill(-pid, "SIGTERM");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
  const grace = deps.graceMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, grace);
      }),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        kill(-pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
      await exited;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
