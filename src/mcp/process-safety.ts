function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return new Set([
    "Error",
    "CdpTimeoutError",
    "CdpProtocolError",
    "CdpDisconnectedError",
    "NavigationInProgressError",
    "DecisionTransportError",
    "InvalidAnswerError",
    "ContextLimitError",
    "UnknownError",
  ]).has(name)
    ? name
    : "Error";
}

export function installProcessSafety(stop: () => Promise<void>): void {
  process.on("unhandledRejection", (error: unknown) => {
    process.stderr.write(`jevpilot-mcp unhandledRejection: ${errorClass(error)}\n`);
  });
  process.on("uncaughtException", (error: Error) => {
    process.stderr.write(`jevpilot-mcp uncaughtException: ${errorClass(error)}\n`);
    process.exitCode = 1;
    void stop().catch(() => {});
    // If graceful shutdown hangs (a stuck browser or transport), exit anyway.
    const forceExit = setTimeout(() => process.exit(1), 30_000);
    forceExit.unref?.();
  });
}
