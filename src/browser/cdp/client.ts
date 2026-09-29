import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from "../errors.ts";

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;
type EventHandler = (params: unknown) => void;
type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CdpEvent = { method: string; params: unknown; sessionId?: string };
export type CdpOptions = {
  timeoutMs?: number;
  onSentMethod?: (method: string, sessionId?: string) => void;
  websocketFactory?: (url: string) => WebSocket;
};

export class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private disconnected = false;
  private readonly timeoutMs: number;
  private readonly onSentMethod: CdpOptions["onSentMethod"];
  get isDisconnected(): boolean {
    return this.disconnected;
  }

  private constructor(socket: WebSocket, options: CdpOptions) {
    this.socket = socket;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.onSentMethod = options.onSentMethod;
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () =>
      this.disconnect(new CdpDisconnectedError("CDP connection closed")),
    );
    socket.addEventListener("error", (event) =>
      this.disconnect(new CdpDisconnectedError("CDP connection error", { cause: event })),
    );
  }

  static async connect(url: string, options: CdpOptions = {}): Promise<CdpClient> {
    const socket = options.websocketFactory?.(url) ?? new WebSocket(url);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new CdpTimeoutError("CDP connection timed out"));
      }, options.timeoutMs ?? 10000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve(new CdpClient(socket, options));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        (event) => {
          clearTimeout(timeout);
          reject(new CdpDisconnectedError("CDP connection failed", { cause: event }));
        },
        { once: true },
      );
    });
  }

  call<M extends keyof Commands & string>(
    method: M,
    params: Commands[M]["paramsType"][0],
    sessionId?: string,
    timeoutMs = this.timeoutMs,
  ): Promise<Commands[M]["returnType"]> {
    if (this.disconnected) return Promise.reject(new CdpDisconnectedError("CDP connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(`${method} timed out`, sessionId));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as Commands[M]["returnType"]),
        reject,
        timer,
      });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
        this.onSentMethod?.(method, sessionId);
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpDisconnectedError("CDP send failed", { cause }));
      }
    });
  }

  async attach(targetId: string): Promise<string> {
    const result = await this.call("Target.attachToTarget", { targetId, flatten: true });
    return result.sessionId;
  }

  on(method: string, handler: EventHandler, sessionId?: string): () => void {
    const key = this.key(method, sessionId);
    const handlers = this.listeners.get(key) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.listeners.set(key, handlers);
    return () => this.off(method, handler, sessionId);
  }

  off(method: string, handler: EventHandler, sessionId?: string): void {
    const key = this.key(method, sessionId);
    this.listeners.get(key)?.delete(handler);
  }

  once<M extends keyof Events & string>(
    method: M,
    handler: (params: Events[M][0]) => void,
    sessionId?: string,
  ): () => void {
    const off = this.on(
      method,
      (params) => {
        off();
        handler(params as Events[M][0]);
      },
      sessionId,
    );
    return off;
  }

  waitForEvent<M extends keyof Events & string>(
    method: M,
    predicate: (params: Events[M][0]) => boolean = () => true,
    timeoutMs = this.timeoutMs,
    sessionId?: string,
  ): Promise<Events[M][0]> {
    return new Promise((resolve, reject) => {
      if (this.disconnected) {
        reject(new CdpDisconnectedError("CDP connection closed"));
        return;
      }
      let offEvent: () => void = () => {};
      let offDisconnect: () => void = () => {};
      const cleanup = () => {
        clearTimeout(timer);
        offEvent();
        offDisconnect();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpTimeoutError(`${method} event timed out`, sessionId));
      }, timeoutMs);
      offEvent = this.on(
        method,
        (params) => {
          const typed = params as Events[M][0];
          if (predicate(typed)) {
            cleanup();
            resolve(typed);
          }
        },
        sessionId,
      );
      offDisconnect = this.on("disconnected", (error) => {
        cleanup();
        reject(error);
      });
    });
  }

  close(): void {
    this.disconnect(new CdpDisconnectedError("CDP connection closed by client"));
    this.socket.close();
  }

  private key(method: string, sessionId?: string): string {
    return `${sessionId ?? ""}\0${method}`;
  }

  private receive(raw: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const data = message as Record<string, unknown>;
    if (typeof data.id === "number") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (typeof data.error === "object" && data.error !== null) {
        const error = data.error as Record<string, unknown>;
        pending.reject(
          new CdpProtocolError(Number(error.code), String(error.message), pending.method),
        );
      } else pending.resolve(data.result ?? {});
      return;
    }
    if (typeof data.method !== "string") return;
    for (const handler of this.listeners.get(
      this.key(data.method, typeof data.sessionId === "string" ? data.sessionId : undefined),
    ) ?? [])
      handler(data.params);
  }

  private disconnect(error: CdpDisconnectedError): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.listeners.get(this.key("disconnected")) ?? []) handler(error);
    this.listeners.clear();
  }
}
