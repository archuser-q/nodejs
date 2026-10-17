import { pool, sql } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';

/** Chạy fn trong 1 transaction, tự COMMIT / ROLLBACK */
export const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const isId = (v) => /^\d+$/.test(String(v ?? ''));

export const assertId = (v, label = 'id') => {
  if (!isId(v)) throw new AppError(400, `${label} không hợp lệ`);
  return Number(v);
};

/** Đọc page/pageSize từ query giống bên dashboard */
export const pagination = (q, defaultSize = 10) => {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

/** Lấy đơn của khách (khoá dòng nếu forUpdate). Không phải đơn của khách => 404 */
export const getOwnedOrder = async (db, orderId, customerId, forUpdate = false) => {
  const { rows } = await sql(db, 
    `SELECT * FROM orders WHERE id = $1 AND customer_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [orderId, customerId],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy đơn hàng');
  return rows[0];
};

export const addHistory = (db, orderId, from, to, changedBy, note = null) =>
  sql(db, 
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, from, to, changedBy, note],
  );

export const ACTIVE_STATUSES = ['pending', 'matching', 'accepted', 'on_the_way', 'arrived', 'in_progress'];
export const CANCELLABLE_STATUSES = ['pending', 'matching', 'accepted'];
export const CHAT_STATUSES = ['accepted', 'on_the_way', 'arrived', 'in_progress', 'completed'];
