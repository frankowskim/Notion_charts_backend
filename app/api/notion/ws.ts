// backend/app/api/notion/ws.ts
import { WebSocketServer, WebSocket } from "ws";

let wss: WebSocketServer | null = (global as any)._wss || null; // globalny singleton

export function initWebSocketServer(server: any) {
  if (wss) {
    console.log("⚠️ WebSocketServer już istnieje – pomijam inicjalizację");
    return wss;
  }

  wss = new WebSocketServer({ server });
  (global as any)._wss = wss; // zapisz w global

  console.log("🚀 WebSocket server initialized");

  wss.on("connection", (ws: WebSocket) => {
    console.log("🔌 Klient połączony z WebSocketem");

    ws.on("close", () => {
      console.log("❌ Klient rozłączony z WebSocketem");
    });
  });

  return wss;
}

export function broadcastChartsUpdate(data: any) {
  if (!wss || wss.clients.size === 0) {
    console.warn(
      "WebSocketServer jeszcze nie gotowy – pominięto wysyłkę danych"
    );
    return;
  }

  const payload = JSON.stringify({
    type: "chartsUpdate",
    charts: data,
  });

  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });

  console.log(`📤 Wysłano update do ${wss.clients.size} klientów`);
}
