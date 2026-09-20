import { Socket } from 'socket.io';

export interface RealtimeSocketData {
  userId?: number;
  activeSessionChannel?: string;
}

export interface RealtimeSocket extends Socket {
  data: RealtimeSocketData;
}
