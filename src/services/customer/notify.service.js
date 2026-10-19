import { q as query, sql } from '../../config/db.js';
import { emitToUser } from '../../realtime/socket.js';
import { sendPush } from '../push.service.js'; // [B] thông báo đẩy Expo (tắt mặc định, PUSH_ENABLED)

/**
 * Tạo thông báo + đẩy realtime. Gọi SAU khi transaction đã COMMIT.
 * type: order | quote | chat | payment | review | complaint | warranty | offer
 */
export const notify = async (userId, { title, body = null, type, data = null }) => {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, body, type, data, is_read, created_at`,
    [userId, title, body, type, data],
  );
  emitToUser(userId, 'notification:new', rows[0]);
  sendPush(userId, rows[0]); // không await: push chậm không làm chậm API
  return rows[0];
};

/** Báo cho các bên liên quan là đơn vừa thay đổi (app tự tải lại) */
export const emitOrderUpdated = (order, extra = {}) => {
  const payload = { order_id: Number(order.id), status: order.status, ...extra };
  emitToUser(order.customer_id, 'order:updated', payload);
  if (order.worker_id) emitToUser(order.worker_id, 'order:updated', payload);
};

export const listNotifications = async (userId, { unreadOnly, pageSize, offset }) => {
  const { rows } = await query(
    `SELECT id, title, body, type, data, is_read, created_at, COUNT(*) OVER()::int AS total
     FROM notifications
     WHERE user_id = $1 AND ($2::boolean IS FALSE OR NOT is_read)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [userId, unreadOnly, pageSize, offset],
  );
  return { items: rows.map(({ total, ...n }) => n), total: rows[0]?.total ?? 0 };
};

export const unreadCount = async (userId) => {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND NOT is_read',
    [userId],
  );
  return rows[0];
};

export const markRead = async (userId, id) => {
  const { rows } = await query(
    `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2
     RETURNING id, title, body, type, data, is_read, created_at`,
    [id, userId],
  );
  return rows[0] ?? null;
};

export const markAllRead = async (userId) => {
  const { rowCount } = await query(
    'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND NOT is_read',
    [userId],
  );
  return { updated: rowCount };
};
