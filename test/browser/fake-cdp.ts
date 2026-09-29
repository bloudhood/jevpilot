import { WebSocketServer, type WebSocket } from "ws";
import { CdpClient } from "../../src/browser/cdp/client.ts";

export type Message = Record<string, unknown>;
export type Send = (body: unknown) => void;

export async function fakeCdp(handler: (message: Message, send: Send) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WebSocket>();
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("message", (raw) =>
      handler(JSON.parse(String(raw)) as Message, (body) => socket.send(JSON.stringify(body))),
    );
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("missing address");
  const client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`);
  return {
    client,
    url: `ws://127.0.0.1:${address.port}/devtools/browser/${address.port}`,
    closeConnections: () => {
      for (const socket of sockets) socket.terminate();
    },
    close: async () => {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
