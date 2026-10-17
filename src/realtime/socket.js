/**
 * Kênh realtime (Socket.IO) cho app khách / app thợ.
 *
 * Client kết nối kèm token:  io(URL, { auth: { token } })
 * Mỗi user vào phòng riêng "user:<id>", server đẩy sự kiện tới đúng người:
 *   order:updated     { order_id, status }            – đơn đổi trạng thái / có báo giá / thanh toán
 *   worker:location   { order_id, lat, lng, updated_at } – vị trí thợ đang tới
 *   message:new       Message                           – tin nhắn mới trong đơn
 *   notification:new  Notification                      – thông báo mới
 */
import { Server } from 'socket.io';
import { authenticate } from '../middlewares/requireCustomer.js';

let io = null;

export const initSocket = (httpServer) => {
  io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  io.use(async (socket, next) => {
    try {
      socket.user = await authenticate(socket.handshake.auth?.token, ['customer', 'worker']);
      next();
    } catch (err) {
      next(new Error(err.message));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
  });

  return io;
};

export const emitToUser = (userId, event, payload) => {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
};
