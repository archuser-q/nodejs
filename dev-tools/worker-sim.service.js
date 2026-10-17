/**
 * [DEV-TOOLS — chỉ để test App Khách hàng, KHÔNG thuộc phần app khách]
 * Giả lập thao tác phía THỢ: nhận đơn, cập nhật trạng thái, gửi vị trí, báo giá phát sinh,
 * xác nhận đã thu tiền mặt. Khi app thợ (của thành viên khác) xong thì bỏ cả thư mục dev-tools.
 */
import { pool, q, sql } from '../src/config/db.js';
import { AppError } from '../src/utils/AppError.js';
import { emitToUser } from '../src/realtime/socket.js';
import { findCandidates } from '../src/services/candidate.js';
import { addHistory, withTransaction } from '../src/services/customer/common.js';
import { emitOrderUpdated, notify } from '../src/services/customer/notify.service.js';
import { settlePayment } from '../src/services/customer/interaction.service.js';

const NEXT = {
  accepted: ['on_the_way', 'arrived'],
  on_the_way: ['arrived'],
  arrived: ['in_progress'],
  in_progress: ['completed'],
};

const CUSTOMER_TEXT = {
  accepted: (o, name) => ['Thợ đã nhận đơn', `${name} đã nhận đơn ${o.code}`],
  on_the_way: (o, name) => ['Thợ đang tới', `${name} đang trên đường tới chỗ bạn`],
  arrived: (o, name) => ['Thợ đã đến nơi', `${name} đã tới địa chỉ của bạn`],
  in_progress: (o) => ['Bắt đầu sửa chữa', `Đơn ${o.code} đang được thực hiện`],
  completed: (o) => ['Đơn đã hoàn thành', `Đơn ${o.code} đã xong, vui lòng thanh toán và đánh giá thợ`],
};

const workerName = async (workerId) =>
  (await q('SELECT full_name FROM users WHERE id = $1', [workerId])).rows[0]?.full_name ?? 'Thợ';

const notifyCustomer = async (order, status) => {
  const [title, body] = CUSTOMER_TEXT[status](order, await workerName(order.worker_id));
  emitOrderUpdated(order);
  await notify(order.customer_id, { title, body, type: 'order', data: { order_id: order.id } });
};

/** Tìm đơn theo id hoặc mã đơn (TN...) */
export const resolveOrderId = async (idOrCode) => {
  const { rows } = await q('SELECT id FROM orders WHERE id::text = $1 OR code = $1', [String(idOrCode)]);
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy đơn hàng');
  return rows[0].id;
};

const loadOrderForWorker = async (db, orderId, workerId) => {
  const { rows } = await sql(db, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const o = rows[0];
  if (!o) throw new AppError(404, 'Không tìm thấy đơn hàng');
  if (workerId && o.worker_id !== workerId) throw new AppError(403, 'Đơn không thuộc về thợ này');
  return o;
};

// ── Nhận đơn ────────────────────────────────────────────────────────────────

/** workerId bỏ trống => lấy thợ xếp hạng cao nhất trong các đề xuất (giả lập) */
export const acceptOrder = async (orderId, workerId = null) => {
  if (!workerId) {
    const { rows } = await q(
      `SELECT worker_id FROM order_offers WHERE order_id = $1 AND status = 'offered'
       ORDER BY rank_position LIMIT 1`,
      [orderId],
    );
    workerId = rows[0]?.worker_id ?? null;
  }
  if (!workerId) {
    // Không có đề xuất nào (VD chưa có thợ online gần đó): lấy thợ phù hợp gần nhất kể cả offline
    const { rows } = await q(
      `SELECT ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng, s.category_id
       FROM orders o JOIN services s ON s.id = o.service_id WHERE o.id = $1`,
      [orderId],
    );
    const cands = await findCandidates({ ...rows[0], radiusKm: 100, includeOffline: true });
    cands.sort((a, b) => a.distance_m - b.distance_m);
    workerId = cands[0] ? Number(cands[0].id) : null;
  }
  if (!workerId) throw new AppError(404, 'Không có thợ nào có kỹ năng phù hợp (chạy npm run seed:dev)');

  const order = await withTransaction(async (db) => {
    const o = await loadOrderForWorker(db, orderId, null);
    if (!['pending', 'matching'].includes(o.status)) throw new AppError(409, 'Đơn đã có thợ nhận hoặc đã huỷ');

    const { rows: busy } = await sql(db, 'SELECT is_busy FROM workers WHERE user_id = $1 FOR UPDATE', [workerId]);
    if (!busy[0]) throw new AppError(404, 'Không tìm thấy thợ');
    if (busy[0].is_busy) throw new AppError(409, 'Thợ đang bận đơn khác');

    await sql(
      db,
      `UPDATE orders SET worker_id = $2, status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orderId, workerId],
    );
    await sql(
      db,
      `INSERT INTO order_offers (order_id, worker_id, mode, score, status, expires_at, responded_at)
       VALUES ($1, $2, $3, 0, 'accepted', NOW(), NOW())
       ON CONFLICT (order_id, worker_id) DO UPDATE SET status = 'accepted', responded_at = NOW()`,
      [orderId, workerId, o.matching_mode],
    );
    await sql(
      db,
      `UPDATE order_offers SET status = 'expired', responded_at = NOW()
       WHERE order_id = $1 AND worker_id <> $2 AND status = 'offered'`,
      [orderId, workerId],
    );
    // Thợ chưa có vị trí (dữ liệu giả lập) => đặt cách địa chỉ khách khoảng 2–3 km
    await sql(
      db,
      `UPDATE workers SET is_busy = TRUE, updated_at = NOW(),
         current_location = COALESCE(current_location,
           ST_SetSRID(ST_MakePoint(ST_X($2::geometry) + 0.02, ST_Y($2::geometry) + 0.015), 4326)::geography),
         location_updated_at = COALESCE(location_updated_at, NOW())
       WHERE user_id = $1`,
      [workerId, o.location],
    );
    await addHistory(db, orderId, o.status, 'accepted', workerId, 'Thợ nhận đơn');
    return { ...o, worker_id: workerId, status: 'accepted' };
  });

  await notifyCustomer(order, 'accepted');
  return { id: order.id, code: order.code, status: order.status, worker_id: workerId };
};

// ── Cập nhật trạng thái ─────────────────────────────────────────────────────

export const updateStatus = async (orderId, workerId, next) => {
  const order = await withTransaction(async (db) => {
    const o = await loadOrderForWorker(db, orderId, workerId);
    if (!NEXT[o.status]?.includes(next)) {
      throw new AppError(400, `Không thể chuyển từ "${o.status}" sang "${next}"`);
    }

    if (next === 'arrived') {
      await sql(
        db,
        'UPDATE workers SET current_location = $2, location_updated_at = NOW() WHERE user_id = $1',
        [o.worker_id, o.location],
      );
    }

    if (next === 'completed') {
      await sql(
        db,
        `UPDATE order_extra_quotes SET status = 'rejected', responded_at = NOW() WHERE order_id = $1 AND status = 'pending'`,
        [orderId],
      );
      await sql(
        db,
        `UPDATE orders o SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
           final_price = o.estimated_price + o.extra_amount,
           warranty_until = CASE WHEN s.warranty_days > 0 THEN NOW() + make_interval(days => s.warranty_days) END
         FROM services s WHERE s.id = o.service_id AND o.id = $1`,
        [orderId],
      );
      await sql(
        db,
        'UPDATE workers SET is_busy = FALSE, total_jobs = total_jobs + 1, updated_at = NOW() WHERE user_id = $1',
        [o.worker_id],
      );
    } else {
      await sql(
        db,
        `UPDATE orders SET status = $2::order_status, updated_at = NOW(),
           started_at = CASE WHEN $2::order_status = 'in_progress' THEN NOW() ELSE started_at END
         WHERE id = $1`,
        [orderId, next],
      );
    }
    await addHistory(db, orderId, o.status, next, o.worker_id);
    return { ...o, status: next };
  });

  await notifyCustomer(order, next);
  return { id: order.id, status: order.status };
};

// ── Vị trí thợ ──────────────────────────────────────────────────────────────

export const updateLocation = async (orderId, workerId, lat, lng) => {
  const { rows } = await q('SELECT id, customer_id, worker_id, status FROM orders WHERE id = $1', [orderId]);
  const o = rows[0];
  if (!o || o.worker_id !== workerId) throw new AppError(404, 'Không tìm thấy đơn hàng');

  const { rows: w } = await q(
    `UPDATE workers SET current_location = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
            location_updated_at = NOW()
     WHERE user_id = $1 RETURNING location_updated_at`,
    [workerId, lat, lng],
  );
  const payload = { order_id: o.id, lat, lng, updated_at: w[0].location_updated_at };
  if (['accepted', 'on_the_way', 'arrived', 'in_progress'].includes(o.status)) {
    emitToUser(o.customer_id, 'worker:location', payload);
  }
  return payload;
};

/** Giả lập: thợ đi thêm một đoạn (ratio) về phía địa chỉ khách */
export const stepTowardCustomer = async (orderId, workerId, ratio = 0.4) => {
  const { rows } = await q(
    `SELECT ST_Y(o.location::geometry) AS dlat, ST_X(o.location::geometry) AS dlng,
            ST_Y(w.current_location::geometry) AS wlat, ST_X(w.current_location::geometry) AS wlng
     FROM orders o JOIN workers w ON w.user_id = o.worker_id WHERE o.id = $1`,
    [orderId],
  );
  const p = rows[0];
  if (!p) throw new AppError(404, 'Đơn chưa có thợ');
  const lat = p.wlat + (p.dlat - p.wlat) * ratio;
  const lng = p.wlng + (p.dlng - p.wlng) * ratio;
  return updateLocation(orderId, workerId, lat, lng);
};

// ── Báo giá phát sinh ───────────────────────────────────────────────────────

export const createExtraQuote = async (orderId, workerId, amount, description) => {
  const { rows: found } = await q('SELECT id, code, status, customer_id, worker_id FROM orders WHERE id = $1', [orderId]);
  const o = found[0];
  if (!o || o.worker_id !== workerId) throw new AppError(404, 'Không tìm thấy đơn hàng');
  if (!['arrived', 'in_progress'].includes(o.status)) {
    throw new AppError(400, 'Chỉ báo giá phát sinh khi đã đến nơi hoặc đang sửa');
  }
  const { rows } = await q(
    `INSERT INTO order_extra_quotes (order_id, worker_id, description, amount)
     VALUES ($1, $2, $3, $4) RETURNING id, description, amount, status, created_at`,
    [orderId, workerId, description, amount],
  );
  emitOrderUpdated(o);
  await notify(o.customer_id, {
    title: 'Thợ gửi báo giá phát sinh',
    body: `${description} · ${Number(amount).toLocaleString('vi-VN')}đ`,
    type: 'quote',
    data: { order_id: o.id, quote_id: rows[0].id },
  });
  return rows[0];
};

// ── Xác nhận đã thu tiền mặt ────────────────────────────────────────────────

export const confirmCash = async (orderId, workerId) => {
  const { rows } = await sql(
    pool,
    `SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.order_id = $1 AND o.worker_id = $2 AND p.method = 'cash' AND p.status = 'pending'`,
    [orderId, workerId],
  );
  if (!rows[0]) throw new AppError(404, 'Khách chưa chọn trả tiền mặt cho đơn này');
  return settlePayment(rows[0].id);
};
