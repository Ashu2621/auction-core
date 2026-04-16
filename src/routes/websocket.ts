import { FastifyInstance } from 'fastify';
import { SocketStream } from '@fastify/websocket';
import { addConnection, removeConnection } from '../internal/websocket/broadcaster';
import { config } from '../config';

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  /**
   * ws://host/ws/auctions/:id
   *
   * Clients subscribe to a specific auction to receive real-time events:
   *   - BID_ACCEPTED: new bid accepted on any lot
   *   - ANTI_SNIPE: closing time extended
   *   - LOT_CLOSED: lot sold or passed
   *
   * Fan-out is via Redis Pub/Sub so multiple server instances all broadcast
   * to their connected clients regardless of which instance accepted the bid.
   *
   * Heartbeat: server sends ping every 10s; clients that don't respond with
   * pong within 5s are disconnected.
   */
  app.get(
    '/ws/auctions/:id',
    { websocket: true },
    (connection: SocketStream, req) => {
      const socket = connection.socket;
      const auctionId = (req.params as { id: string }).id;

      // Register with broadcaster
      addConnection(auctionId, socket);

      // Send initial connection confirmation
      socket.send(JSON.stringify({ type: 'CONNECTED', auction_id: auctionId }));

      // Heartbeat setup: ping every 10s, wait 5s for pong
      let isAlive = true;
      let pongTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          // Client did not respond to last ping — terminate
          socket.terminate();
          return;
        }

        isAlive = false;
        socket.ping();

        // Set a 5-second timeout for the pong response
        pongTimeoutHandle = setTimeout(() => {
          if (!isAlive) {
            socket.terminate();
          }
        }, config.wsPongTimeoutMs);
      }, config.wsHeartbeatMs);

      socket.on('pong', () => {
        isAlive = true;
        if (pongTimeoutHandle) {
          clearTimeout(pongTimeoutHandle);
          pongTimeoutHandle = null;
        }
      });

      socket.on('close', () => {
        clearInterval(heartbeatInterval);
        if (pongTimeoutHandle) clearTimeout(pongTimeoutHandle);
        removeConnection(auctionId, socket);
      });

      socket.on('error', () => {
        clearInterval(heartbeatInterval);
        if (pongTimeoutHandle) clearTimeout(pongTimeoutHandle);
        removeConnection(auctionId, socket);
      });

      // Ignore inbound messages (server-push only channel)
      socket.on('message', () => {});
    }
  );
}
