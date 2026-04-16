import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { wsConnectionsActive } from '../../metrics';

// Map from auctionId → Set of connected WebSocket sockets
const connections = new Map<string, Set<WebSocket>>();

let subscriberClient: Redis | null = null;

/**
 * Initialize the broadcaster with a dedicated Redis subscriber connection.
 * Must be called once at startup before WebSocket routes are registered.
 */
export function initBroadcaster(subscriber: Redis): void {
  subscriberClient = subscriber;

  // Use pattern subscribe to catch all auction channels
  subscriber.psubscribe('auction:*', (err) => {
    if (err) {
      console.error('[broadcaster] Failed to subscribe to auction:* pattern:', err);
    } else {
      console.log('[broadcaster] Subscribed to auction:* channels');
    }
  });

  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const auctionId = channel.replace('auction:', '');
    fanOut(auctionId, message);
  });
}

/**
 * Register a WebSocket connection for an auction.
 * Multiple clients can subscribe to the same auction.
 */
export function addConnection(auctionId: string, socket: WebSocket): void {
  if (!connections.has(auctionId)) {
    connections.set(auctionId, new Set());
  }
  connections.get(auctionId)!.add(socket);
  wsConnectionsActive.inc();
  console.log(
    `[broadcaster] Client connected to auction=${auctionId} total=${connections.get(auctionId)!.size}`
  );
}

/**
 * Remove a WebSocket connection (called on close/error).
 */
export function removeConnection(auctionId: string, socket: WebSocket): void {
  const sockets = connections.get(auctionId);
  if (sockets) {
    sockets.delete(socket);
    wsConnectionsActive.dec();
    if (sockets.size === 0) {
      connections.delete(auctionId);
    }
  }
}

/**
 * Fan out a message to all connected clients for a given auction.
 * Dead connections are cleaned up on send error.
 */
function fanOut(auctionId: string, message: string): void {
  const sockets = connections.get(auctionId);
  if (!sockets || sockets.size === 0) return;

  const dead: WebSocket[] = [];

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(message);
      } catch {
        dead.push(socket);
      }
    } else if (socket.readyState !== WebSocket.CONNECTING) {
      dead.push(socket);
    }
  }

  for (const socket of dead) {
    sockets.delete(socket);
    wsConnectionsActive.dec();
  }
}

/** Return the number of active connections for an auction (for testing/monitoring). */
export function connectionCount(auctionId: string): number {
  return connections.get(auctionId)?.size ?? 0;
}
