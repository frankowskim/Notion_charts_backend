// app/api/notion/ws.ts
import { Server as HTTPServer } from "http";
import WebSocket, { WebSocketServer } from "ws";

let wss: WebSocketServer | null = null;

export function initWebSocketServer(server: HTTPServer) {
  if (wss) return; // zapobiega wielokrotnej inicjalizacji

  wss = new WebSocketServer({ server });
  console.log("🟢 WebSocketServer gotowy");

  wss.on("connection", (ws) => {
    console.log("🔌 Klient WS połączony");

    ws.on("close", () => {
      console.log("❌ Klient WS rozłączony");
    });
  });
}

export function broadcastChartsUpdate(data: any) {
  if (!wss) {
    console.warn(
      "WebSocketServer jeszcze nie gotowy – pominięto wysyłkę danych"
    );
    return;
  }

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
