// server.ts
import http from "http";
import next from "next";
import { initWebSocketServer } from "./app/api/notion/ws";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.prepare().then(() => {
  const server = http.createServer((req, res) => handle(req, res));

  initWebSocketServer(server);

  server.listen(PORT, () => {
    console.log(`🟢 Serwer działa na http://localhost:${PORT}`);
  });
});
