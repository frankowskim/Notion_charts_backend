// backend/app/api/notion/ws.ts
import { WebSocketServer, WebSocket } from "ws";

let wss: WebSocketServer | null = null;

/**
 * Inicjalizacja WebSocketServer na bazie istniejącego serwera HTTP
 */
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

/**
 * Wysyła zaktualizowane dane wykresów do wszystkich połączonych klientów
 */
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
