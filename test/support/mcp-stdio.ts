import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class TestStdioTransport implements Transport {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[] = [];
  readonly stderrLines: string[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private pending = "";

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    entry = new URL("./mcp-test-server.ts", import.meta.url),
  ) {
    this.child = spawn(process.execPath, [fileURLToPath(entry)], {
      env,
      stdio: "pipe",
      shell: false,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.pending += chunk;
      for (;;) {
        const end = this.pending.indexOf("\n");
        if (end < 0) break;
        const line = this.pending.slice(0, end).trim();
        this.pending = this.pending.slice(end + 1);
        if (!line) continue;
        this.stdoutLines.push(line);
        try {
          this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        } catch (error) {
          this.onerror?.(error as Error);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderrLines.push(chunk));
    this.child.once("exit", () => this.onclose?.());
    this.child.once("error", (error) => this.onerror?.(error));
  }
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  async close(): Promise<void> {
    this.child.stdin.end();
  }
  async exited(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP child did not exit")), 5000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
