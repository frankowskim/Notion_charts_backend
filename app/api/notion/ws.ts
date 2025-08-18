// app/api/notion/ws.ts
import { Server as HTTPServer } from "http";
import WebSocket, { WebSocketServer } from "ws";

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function initWebSocketServer(server: HTTPServer) {
  if (wss) return; // już zainicjalizowany

  wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    console.log("🔌 Nowe połączenie WebSocket");

    ws.on("close", () => {
      clients.delete(ws);
      console.log("❌ Połączenie WebSocket zamknięte");
    });
  });
}

// Ta funkcja musi istnieć, bo route.ts jej używa
export function broadcastChartsUpdate(data: any) {
  if (!wss || clients.size === 0) {
    console.log(
      "WebSocketServer jeszcze nie gotowy – pominięto wysyłkę danych"
    );
    return;
  }

  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
