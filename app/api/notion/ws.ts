import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import next from "next";
import dotenv from "dotenv";

dotenv.config();

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const PORT = parseInt(process.env.PORT || "3000", 10);

let wss: WebSocketServer;

// Funkcja broadcast, która sprawdza, czy wss istnieje
function broadcastChartsUpdate(data: any) {
  if (!wss) {
    console.warn(
      "WebSocketServer jeszcze nie gotowy – pominięto wysyłkę danych"
    );
    return;
  }

  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Eksport funkcji od razu
export { broadcastChartsUpdate };

app.prepare().then(() => {
  const server = http.createServer((req, res) => handle(req, res));

  wss = new WebSocketServer({ server });

  console.log(`🚀 WebSocket serwer zintegrowany z backendem na porcie ${PORT}`);

  wss.on("connection", (ws: WebSocket) => {
    console.log("🔌 Klient połączony z WebSocketem");

    ws.on("close", () => {
      console.log("❌ Klient rozłączony z WebSocketem");
    });
  });

  server.listen(PORT, () => {
    console.log(`🟢 Serwer działa na http://localhost:${PORT}`);
  });
});
