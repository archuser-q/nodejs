import { pool, query } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { emitToUser } from '../../realtime/socket.js';
import { emitOrderUpdated, notify } from '../shared/notify.service.js';
import { refreshAvailability } from '../worker/state.js';

export const listOrders = async ({ search, status, from, to, page, pageSize }) => {
  const params = [];
  const conditions = ['TRUE'];

  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`o.created_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    conditions.push(`o.created_at < $${params.length}::date + 1`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(o.code ILIKE ${p} OR c.full_name ILIKE ${p} OR c.phone ILIKE ${p} OR w.full_name ILIKE ${p})`);
  }

  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await query(
    `SELECT o.id, o.code, o.status, o.matching_mode, o.created_at, o.scheduled_at, o.address_text,
            COALESCE(o.final_price, o.estimated_price)::float8 AS price,
            c.full_name AS customer_name, c.phone AS customer_phone,
            w.full_name AS worker_name, s.name AS service_name, cat.name AS category_name,
            COUNT(*) OVER()::int AS total
     FROM orders o
     JOIN users c ON c.id = o.customer_id
     JOIN services s ON s.id = o.service_id
     JOIN service_categories cat ON cat.id = s.category_id
     LEFT JOIN users w ON w.id = o.worker_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const total = rows[0]?.total ?? 0;
  return { items: rows.map(({ total, ...order }) => order), total };
};

export const getOrderDetail = async (id) => {
  const [order, history, quotes, payments, review, photos, offers, trail, dispatch] = await Promise.all([
    query(
      `SELECT o.id, o.code, o.status, o.matching_mode, o.address_text, o.description, o.image_urls,
              o.scheduled_at, o.created_at, o.accepted_at, o.started_at, o.completed_at,
              o.cancelled_at, o.cancel_reason, o.warranty_until, o.safety_checked_at,
              o.estimated_price::float8 AS estimated_price, o.extra_amount::float8 AS extra_amount,
              o.final_price::float8 AS final_price, o.commission_amount::float8 AS commission_amount,
              ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
              s.name AS service_name, cat.name AS category_name,
              c.id AS customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
              w.id AS worker_id, w.full_name AS worker_name, w.phone AS worker_phone,
              cb.full_name AS cancelled_by_name
       FROM orders o
       JOIN services s ON s.id = o.service_id
       JOIN service_categories cat ON cat.id = s.category_id
       JOIN users c ON c.id = o.customer_id
       LEFT JOIN users w ON w.id = o.worker_id
       LEFT JOIN users cb ON cb.id = o.cancelled_by
       WHERE o.id = $1`,
      [id],
    ),
    query(
      `SELECT h.id, h.from_status, h.to_status, h.note, h.created_at, u.full_name AS changed_by_name
       FROM order_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.order_id = $1
       ORDER BY h.created_at`,
      [id],
    ),
    query(
      `SELECT id, description, amount::float8 AS amount, status, created_at
       FROM order_extra_quotes WHERE order_id = $1 ORDER BY created_at`,
      [id],
    ),
    query(
      `SELECT id, method, amount::float8 AS amount, status, provider_txn_id, paid_at, created_at
       FROM payments WHERE order_id = $1 ORDER BY created_at`,
      [id],
    ),
    query(
      `SELECT id, rating, comment, is_flagged, created_at FROM reviews WHERE order_id = $1`,
      [id],
    ),
    // Ảnh trước / sau khi sửa do thợ chụp trên app thợ (bằng chứng khi có khiếu nại)
    query(
      `SELECT id, kind, url, created_at FROM order_photos WHERE order_id = $1 ORDER BY kind DESC, created_at`,
      [id],
    ),
    // Lịch sử lời mời của bộ điều phối: mời ai, đợt mấy, điểm phù hợp, thợ trả lời thế nào
    query(
      `SELECT f.id, f.worker_id, u.full_name AS worker_name, f.mode, f.round, f.rank_position,
              f.score::float8 AS score, f.distance_km::float8 AS distance_km, f.status, f.reason,
              f.offered_at, f.expires_at, f.responded_at
       FROM order_offers f JOIN users u ON u.id = f.worker_id
       WHERE f.order_id = $1
       ORDER BY f.offered_at, f.rank_position NULLS LAST`,
      [id],
    ),
    // Vết di chuyển của thợ khi làm đơn này (app thợ gửi ~20 giây / điểm)
    query(
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, recorded_at
       FROM worker_location_logs WHERE order_id = $1 ORDER BY recorded_at LIMIT 2000`,
      [id],
    ),
    query(
      `SELECT mode, rounds, offers_sent, last_candidates, next_attempt_at, last_attempt_at, deadline_at, created_at
       FROM order_dispatches WHERE order_id = $1`,
      [id],
    ),
  ]);

  if (!order.rows[0]) throw new AppError(404, 'Không tìm thấy đơn hàng');

  return {
    order: order.rows[0],
    history: history.rows,
    quotes: quotes.rows,
    payments: payments.rows,
    review: review.rows[0] ?? null,
    photos: photos.rows,
    offers: offers.rows,
    trail: trail.rows,
    dispatch: dispatch.rows[0] ?? null,
  };
};

export const cancelOrder = async (id, adminId, reason) => {
  const client = await pool.connect();
  let after;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, code, status, customer_id, worker_id FROM orders WHERE id = $1 FOR UPDATE',
      [id],
    );
    const order = rows[0];
    if (!order) throw new AppError(404, 'Không tìm thấy đơn hàng');
    if (['completed', 'cancelled'].includes(order.status)) {
      throw new AppError(400, order.status === 'completed' ? 'Đơn đã hoàn thành, không huỷ được' : 'Đơn đã bị huỷ trước đó');
    }

    await client.query(
      `UPDATE orders
       SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, adminId, reason],
    );
    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
       VALUES ($1, $2, 'cancelled', $3, $4)`,
      [id, order.status, adminId, reason],
    );
    // [B] đóng lời mời đang mở, tính lại cờ bận của thợ (thay vì đặt thẳng FALSE)
    const { rows: closed } = await client.query(
      `UPDATE order_offers SET status = 'expired', responded_at = NOW(), reason = 'closed'
       WHERE order_id = $1 AND status = 'offered' RETURNING id, worker_id`,
      [id],
    );
    if (order.worker_id) await refreshAvailability(client, order.worker_id);

    await client.query('COMMIT');
    after = { order, closed };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // [B] sau khi COMMIT: báo cho khách + thợ (thợ có thể đang trên đường tới), gỡ lời mời trên app thợ
  const { order, closed } = after;
  for (const f of closed) emitToUser(Number(f.worker_id), 'offer:closed', { offer_id: Number(f.id), order_id: Number(id) });
  emitOrderUpdated({ ...order, status: 'cancelled' });
  const body = `Đơn ${order.code} đã bị huỷ bởi quản trị viên${reason ? `: ${reason}` : ''}`;
  await notify(order.customer_id, { title: 'Đơn hàng đã bị huỷ', body, type: 'order', data: { order_id: Number(id) } });
  if (order.worker_id) await notify(order.worker_id, { title: 'Đơn đã bị huỷ', body, type: 'order', data: { order_id: Number(id) } });
};