import type { Server } from 'socket.io';

let io: Server | null = null;

export const setSocketServer = (server: Server) => {
  io = server;
};

export const getSocketServer = (): Server => {
  if (!io) {
    throw new Error('Socket.io server not initialized');
  }
  return io;
};
