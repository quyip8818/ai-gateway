import { once } from "node:events";
import { lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";

export async function replaceLauncher(path, stop) {
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => connections.delete(socket));
    stop();
  });

  for (;;) {
    try {
      const listening = once(server, "listening");
      server.listen(path);
      await listening;
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }

    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) continue;
    if (!entry.isSocket()) throw new Error(`启动控制路径被占用：${path}`);

    const socket = createConnection(path);
    socket.resume();
    socket.setTimeout(45_000, () =>
      socket.destroy(new Error("等待上一次 pnpm start 退出超时")),
    );
    try {
      await once(socket, "close");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code !== "ECONNREFUSED") throw error;
      const current = lstatSync(path, { throwIfNoEntry: false });
      // Only remove the socket we tried to connect to.
      if (current?.dev === entry.dev && current.ino === entry.ino) {
        try {
          unlinkSync(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  return () => {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of connections) socket.destroy();
    return closed;
  };
}
