import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BrowserLaunchError } from "../../src/browser/errors.ts";
import {
  findChrome,
  parseDevToolsActivePort,
  waitForDevToolsPort,
} from "../../src/browser/launcher.ts";

describe("Chrome discovery", () => {
  test("parses an active port file", () => {
    assert.deepEqual(parseDevToolsActivePort("1234\n/devtools/browser/id\n"), {
      port: 1234,
      path: "/devtools/browser/id",
    });
  });

  test("times out while waiting for the active port", async () => {
    await assert.rejects(
      waitForDevToolsPort("unused", 20, {
        readFile: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
      BrowserLaunchError,
    );
  });

  test("launcher retries DevToolsActivePort reads that fail with EBUSY or EPERM", async () => {
    const errors = ["EBUSY", "EPERM"];
    const address = await waitForDevToolsPort("unused", 1000, {
      readFile: async () => {
        const code = errors.shift();
        if (code) throw Object.assign(new Error(code), { code });
        return "1234\n/devtools/browser/id\n";
      },
    });
    assert.equal(address, "ws://127.0.0.1:1234/devtools/browser/id");
    assert.equal(errors.length, 0);
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await assert.rejects(
      waitForDevToolsPort("unused", 1000, { readFile: async () => Promise.reject(denied) }),
      (error) => error === denied,
    );
  });

  test("prefers Chrome at any Windows location over Edge", async () => {
    const result = await findChrome({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      access: async (path) => {
        if (!path.endsWith("chrome.exe") || !path.includes("AppData")) {
          if (!path.endsWith("msedge.exe")) throw new Error("missing");
        }
      },
    });
    assert.equal(
      result,
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    );
  });

  test("discovers Linux Chromium using POSIX paths", async () => {
    const result = await findChrome({
      platform: "linux",
      env: { PATH: "/bin" },
      access: async (path) => {
        if (path !== "/bin/chromium") throw new Error("missing");
      },
    });
    assert.equal(result, "/bin/chromium");
  });
});
