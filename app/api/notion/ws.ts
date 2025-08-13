// ws.ts
import { WebSocketServer, WebSocket } from "ws";

let wss: WebSocketServer | null = null;

export function initWebSocketServer(server: any) {
  wss = new WebSocketServer({ server });

  console.log(`🚀 WebSocket server initialized`);

  wss.on("connection", (ws: WebSocket) => {
    console.log("🔌 Klient połączony z WebSocketem");

    ws.on("close", () => {
      console.log("❌ Klient rozłączony z WebSocketem");
    });
  });
}

// Funkcja broadcast może działać nawet jeśli wss nie istnieje
export function broadcastChartsUpdate(data: any) {
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
