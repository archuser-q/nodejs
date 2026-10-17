import crypto from 'crypto';
import { pool, q, sql } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { emitToUser } from '../../realtime/socket.js';
import { CHAT_STATUSES, getOwnedOrder, withTransaction } from './common.js';
import { emitOrderUpdated, notify } from './notify.service.js';

const money = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;

// ── Chat ────────────────────────────────────────────────────────────────────

const MESSAGE_FIELDS = `id, order_id, sender_id, content, image_url, read_at IS NOT NULL AS is_read, created_at`;

const orderForChat = async (db, orderId, userId) => {
  const { rows } = await sql(
    db,
    'SELECT id, code, status, customer_id, worker_id FROM orders WHERE id = $1 AND (customer_id = $2 OR worker_id = $2)',
    [orderId, userId],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy đơn hàng');
  return rows[0];
};

export const listMessages = async (userId, orderId, { beforeId, limit }) => {
  await orderForChat(pool, orderId, userId);
  const { rows } = await q(
    `SELECT * FROM (
       SELECT ${MESSAGE_FIELDS} FROM messages
       WHERE order_id = $1 AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $3
     ) m ORDER BY id`,
    [orderId, beforeId ?? null, limit],
  );
  return rows;
};

/** Gửi tin nhắn — dùng chung cho khách và thợ (senderId là người gửi) */
export const sendMessage = async (senderId, orderId, content) => {
  const { rows: found } = await q(
    'SELECT id, code, status, customer_id, worker_id FROM orders WHERE id = $1 AND (customer_id = $2 OR worker_id = $2)',
    [orderId, senderId],
  );
  const order = found[0];
  if (!order) throw new AppError(404, 'Không tìm thấy đơn hàng');
  if (!order.worker_id || !CHAT_STATUSES.includes(order.status)) {
    throw new AppError(400, 'Chỉ nhắn tin được khi thợ đã nhận đơn');
  }

  const { rows } = await q(
    `INSERT INTO messages (order_id, sender_id, content) VALUES ($1, $2, $3) RETURNING ${MESSAGE_FIELDS}`,
    [orderId, senderId, content],
  );
  const message = rows[0];
  const receiverId = senderId === order.customer_id ? order.worker_id : order.customer_id;

  emitToUser(order.customer_id, 'message:new', message);
  emitToUser(order.worker_id, 'message:new', message);
  await notify(receiverId, {
    title: senderId === order.customer_id ? 'Tin nhắn từ khách hàng' : 'Tin nhắn từ thợ',
    body: content.length > 80 ? `${content.slice(0, 80)}…` : content,
    type: 'chat',
    data: { order_id: order.id, message_id: message.id },
  });
  return message;
};

export const markMessagesRead = async (userId, orderId) => {
  const { rows: found } = await q(
    'SELECT id, customer_id, worker_id FROM orders WHERE id = $1 AND (customer_id = $2 OR worker_id = $2)',
    [orderId, userId],
  );
  if (!found[0]) throw new AppError(404, 'Không tìm thấy đơn hàng');
  const { rowCount } = await q(
    'UPDATE messages SET read_at = NOW() WHERE order_id = $1 AND sender_id <> $2 AND read_at IS NULL',
    [orderId, userId],
  );
  return { updated: rowCount };
};

// ── Thanh toán ──────────────────────────────────────────────────────────────

const PAYMENT_FIELDS = 'id, order_id, method, amount, status, provider_txn_id, created_at, paid_at';

export const createPayment = async (customerId, orderId, method) => {
  const result = await withTransaction(async (db) => {
    const o = await getOwnedOrder(db, orderId, customerId, true);
    if (o.status !== 'completed') throw new AppError(400, 'Chỉ thanh toán được khi đơn đã hoàn thành');

    const { rows: existing } = await sql(
      db,
      "SELECT id, method, status FROM payments WHERE order_id = $1 AND status IN ('pending', 'success')",
      [orderId],
    );
    if (existing.some((p) => p.status === 'success')) throw new AppError(409, 'Đơn này đã được thanh toán');
    if (existing.some((p) => p.method === 'cash')) {
      throw new AppError(409, 'Bạn đã chọn trả tiền mặt, đang chờ thợ xác nhận');
    }
    // Lần thanh toán ví trước chưa xong => huỷ để tạo lần mới
    await sql(db, "UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'pending'", [orderId]);

    const amount = o.final_price ?? Number(o.estimated_price) + Number(o.extra_amount);
    const txn = method === 'cash' ? null : `SANDBOX-${method.toUpperCase()}-${crypto.randomBytes(5).toString('hex')}`;
    const { rows } = await sql(
      db,
      `INSERT INTO payments (order_id, method, amount, provider_txn_id) VALUES ($1, $2, $3, $4)
       RETURNING ${PAYMENT_FIELDS}`,
      [orderId, method, amount, txn],
    );
    return { order: o, payment: rows[0] };
  });

  emitOrderUpdated(result.order);
  if (method === 'cash') {
    await notify(result.order.worker_id, {
      title: 'Khách trả tiền mặt',
      body: `Đơn ${result.order.code}: thu ${money(result.payment.amount)} và xác nhận trên app`,
      type: 'payment',
      data: { order_id: result.order.id, payment_id: result.payment.id },
    });
  }
  // Sandbox: chưa có cổng thật nên không có pay_url, app tự gọi sandbox-confirm
  return { ...result.payment, pay_url: null };
};

/**
 * Ghi nhận thanh toán thành công. Phần cộng/trừ ví thợ, hoa hồng (worker_transactions)
 * thuộc module thu nhập của App Thợ — không xử lý ở đây.
 */
export const settlePayment = (paymentId) =>
  withTransaction(async (db) => {
    const { rows } = await sql(
      db,
      `UPDATE payments SET status = 'success', paid_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING ${PAYMENT_FIELDS}`,
      [paymentId],
    );
    const payment = rows[0];
    if (!payment) throw new AppError(400, 'Giao dịch không ở trạng thái chờ thanh toán');

    const { rows: ord } = await sql(
      db,
      `UPDATE orders SET final_price = COALESCE(final_price, $2), updated_at = NOW()
       WHERE id = $1
       RETURNING id, code, status, customer_id, worker_id`,
      [payment.order_id, payment.amount],
    );
    return { payment, order: ord[0] };
  }).then(async ({ payment, order }) => {
    emitOrderUpdated(order);
    await notify(order.customer_id, {
      title: 'Thanh toán thành công',
      body: `Đơn ${order.code}: ${money(payment.amount)}`,
      type: 'payment',
      data: { order_id: order.id, payment_id: payment.id },
    });
    if (order.worker_id) {
      await notify(order.worker_id, {
        title: 'Đơn đã được thanh toán',
        body: `Đơn ${order.code}: ${money(payment.amount)}`,
        type: 'payment',
        data: { order_id: order.id, payment_id: payment.id },
      });
    }
    return payment;
  });

export const sandboxConfirm = async (customerId, paymentId) => {
  if (env.isProd) throw new AppError(403, 'Chỉ dùng được ở môi trường thử nghiệm');
  const { rows } = await q(
    `SELECT p.id, p.method, p.status FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.id = $1 AND o.customer_id = $2`,
    [paymentId, customerId],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy giao dịch');
  if (rows[0].method === 'cash') throw new AppError(400, 'Thanh toán tiền mặt do thợ xác nhận');
  return settlePayment(paymentId);
};

export const listMyPayments = async (customerId, { pageSize, offset }) => {
  const { rows } = await q(
    `SELECT p.id, p.order_id, o.code AS order_code, s.name AS service_name, p.method, p.amount, p.status,
            p.provider_txn_id, p.created_at, p.paid_at, COUNT(*) OVER()::int AS total
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN services s ON s.id = o.service_id
     WHERE o.customer_id = $1
     ORDER BY p.created_at DESC
     LIMIT $2 OFFSET $3`,
    [customerId, pageSize, offset],
  );
  return { items: rows.map(({ total, ...p }) => p), total: rows[0]?.total ?? 0 };
};

// ── Đánh giá ────────────────────────────────────────────────────────────────

export const createReview = async (customerId, orderId, rating, comment) => {
  const result = await withTransaction(async (db) => {
    const o = await getOwnedOrder(db, orderId, customerId, true);
    if (o.status !== 'completed' || !o.worker_id) throw new AppError(400, 'Chỉ đánh giá được đơn đã hoàn thành');

    const { rows: dup } = await sql(db, 'SELECT 1 FROM reviews WHERE order_id = $1', [orderId]);
    if (dup.length) throw new AppError(409, 'Bạn đã đánh giá đơn này');

    const { rows } = await sql(
      db,
      `INSERT INTO reviews (order_id, customer_id, worker_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, rating, comment, created_at`,
      [orderId, customerId, o.worker_id, rating, comment],
    );
    // Điểm trung bình đơn giản; trust score do module Review (thuật toán trust score) cập nhật riêng
    await sql(
      db,
      `UPDATE workers SET
         rating_count = sub.cnt, rating_avg = ROUND(sub.avg, 2), updated_at = NOW()
       FROM (SELECT COUNT(*) AS cnt, AVG(rating) AS avg FROM reviews WHERE worker_id = $1) sub
       WHERE user_id = $1`,
      [o.worker_id],
    );
    return { order: o, review: rows[0] };
  });

  emitOrderUpdated(result.order);
  await notify(result.order.worker_id, {
    title: `Bạn nhận được đánh giá ${rating} sao`,
    body: comment ? (comment.length > 80 ? `${comment.slice(0, 80)}…` : comment) : `Đơn ${result.order.code}`,
    type: 'review',
    data: { order_id: result.order.id, review_id: result.review.id },
  });
  return result.review;
};

export const listMyReviews = async (customerId, { pageSize, offset }) => {
  const { rows } = await q(
    `SELECT r.id, r.order_id, o.code AS order_code, r.worker_id, u.full_name AS worker_name,
            s.name AS service_name, r.rating, r.comment, r.created_at, COUNT(*) OVER()::int AS total
     FROM reviews r
     JOIN orders o ON o.id = r.order_id
     JOIN services s ON s.id = o.service_id
     JOIN users u ON u.id = r.worker_id
     WHERE r.customer_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [customerId, pageSize, offset],
  );
  return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
};

// ── Khiếu nại / bảo hành ────────────────────────────────────────────────────

const COMPLAINT_FIELDS = 'id, order_id, type, title, content, status, resolution, created_at, resolved_at';

export const createComplaint = async (customerId, orderId, title, content) => {
  const o = await getOwnedOrder(pool, orderId, customerId);
  if (!o.worker_id || o.status === 'cancelled') {
    throw new AppError(400, 'Chỉ khiếu nại được đơn đã có thợ nhận');
  }
  const { rows } = await q(
    `INSERT INTO complaints (order_id, customer_id, type, title, content)
     VALUES ($1, $2, 'complaint', $3, $4) RETURNING ${COMPLAINT_FIELDS}`,
    [orderId, customerId, title, content],
  );
  return rows[0];
};

export const claimWarranty = async (customerId, orderId, content) => {
  const result = await withTransaction(async (db) => {
    const o = await getOwnedOrder(db, orderId, customerId, true);
    if (o.status !== 'completed' || !o.warranty_until) throw new AppError(400, 'Đơn này không có bảo hành');
    if (new Date(o.warranty_until) <= new Date()) throw new AppError(400, 'Đơn đã hết thời hạn bảo hành');

    const { rows: open } = await sql(
      db,
      `SELECT 1 FROM complaints WHERE order_id = $1 AND type = 'warranty' AND status IN ('open', 'processing')`,
      [orderId],
    );
    if (open.length) throw new AppError(409, 'Yêu cầu bảo hành trước đó đang được xử lý');

    const { rows } = await sql(
      db,
      `INSERT INTO complaints (order_id, customer_id, type, title, content)
       VALUES ($1, $2, 'warranty', $3, $4) RETURNING ${COMPLAINT_FIELDS}`,
      [orderId, customerId, `Yêu cầu bảo hành đơn ${o.code}`, content],
    );
    return { order: o, complaint: rows[0] };
  });

  if (result.order.worker_id) {
    await notify(result.order.worker_id, {
      title: 'Khách yêu cầu bảo hành',
      body: `Đơn ${result.order.code}: ${content.slice(0, 80)}`,
      type: 'warranty',
      data: { order_id: result.order.id, complaint_id: result.complaint.id },
    });
  }
  return result.complaint;
};

export const listMyComplaints = async (customerId) => {
  const { rows } = await q(
    `SELECT c.id, c.order_id, o.code AS order_code, c.type, c.title, c.content, c.status, c.resolution,
            c.created_at, c.resolved_at
     FROM complaints c JOIN orders o ON o.id = c.order_id
     WHERE c.customer_id = $1 ORDER BY c.created_at DESC LIMIT 100`,
    [customerId],
  );
  return rows;
};

// ── Hồ sơ công khai của thợ ─────────────────────────────────────────────────

export const getWorkerPublic = async (workerId) => {
  const { rows } = await q(
    `SELECT u.id, u.full_name, u.avatar_url, w.bio, w.experience_years, w.rating_avg, w.rating_count,
            w.trust_score, w.total_jobs, w.verification_status = 'approved' AS verified,
            COALESCE(ARRAY(
              SELECT c.name FROM worker_skills ws JOIN service_categories c ON c.id = ws.category_id
              WHERE ws.worker_id = w.user_id ORDER BY c.sort_order, c.name
            ), '{}') AS skills
     FROM workers w JOIN users u ON u.id = w.user_id
     WHERE w.user_id = $1 AND u.status = 'active'`,
    [workerId],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy thợ');

  const { rows: reviews } = await q(
    `SELECT r.rating, r.comment, u.full_name AS customer_name, r.created_at
     FROM reviews r JOIN users u ON u.id = r.customer_id
     WHERE r.worker_id = $1 AND NOT r.is_flagged
     ORDER BY r.created_at DESC LIMIT 5`,
    [workerId],
  );
  return { ...rows[0], recent_reviews: reviews };
};
