import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, test } from "node:test";
import { spawnBrowser, stopBrowser, type Spawn } from "../../src/browser/process.ts";

function child(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
  }) as ChildProcess;
}

describe("browser process management", () => {
  test("spawns Windows without a shell", () => {
    let options: unknown;
    const spawn = ((_exe: string, _args: string[], received: unknown) => {
      options = received;
      return child(100);
    }) as Spawn;
    spawnBrowser("chrome", [], { platform: "win32", spawn });
    assert.deepEqual(options, { shell: false, stdio: "ignore", detached: false });
  });

  test("spawns POSIX in its own process group", () => {
    let options: unknown;
    const spawn = ((_exe: string, _args: string[], received: unknown) => {
      options = received;
      return child(101);
    }) as Spawn;
    spawnBrowser("chromium", [], { platform: "linux", spawn });
    assert.deepEqual(options, { shell: false, stdio: "ignore", detached: true });
  });

  test("uses taskkill for a Windows process tree and waits for exit", async () => {
    const browser = child(102);
    const commands: [string, string[]][] = [];
    const spawn = ((name: string, args: string[]) => {
      commands.push([name, args]);
      const killer = child(103);
      queueMicrotask(() => {
        killer.emit("exit", 0);
        browser.emit("exit", 0);
      });
      return killer;
    }) as Spawn;
    await stopBrowser(browser, { platform: "win32", spawn });
    assert.deepEqual(commands, [["taskkill", ["/PID", "102", "/T", "/F"]]]);
  });

  test("sends SIGTERM to the POSIX process group", async () => {
    const browser = child(104);
    const signals: [number, NodeJS.Signals][] = [];
    await stopBrowser(browser, {
      platform: "linux",
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        queueMicrotask(() => {
          Object.defineProperty(browser, "exitCode", { value: 0, configurable: true });
          browser.emit("exit", 0);
        });
      },
    });
    assert.deepEqual(signals, [[-104, "SIGTERM"]]);
  });
});
