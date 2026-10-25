import { q, sql } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import {
  ACTIVE_STATUSES, CANCELLABLE_STATUSES, addHistory, getOwnedOrder, withTransaction,
} from './common.js';
import { dispatchOffers, getConfig, refreshOffers } from './dispatch.service.js';
import { emitOrderUpdated, notify } from './notify.service.js';
import { emitToUser } from '../../realtime/socket.js';
import { refreshAvailability } from '../worker/state.js'; // [B]

const WORKER_BRIEF = `CASE WHEN o.worker_id IS NULL THEN NULL ELSE json_build_object(
    'id', wu.id, 'full_name', wu.full_name, 'phone', wu.phone, 'avatar_url', wu.avatar_url,
    'rating_avg', w.rating_avg, 'rating_count', w.rating_count, 'trust_score', w.trust_score,
    'total_jobs', w.total_jobs, 'experience_years', w.experience_years
  ) END AS worker`;

const ORDER_SELECT = `
  SELECT o.id, o.code, o.status, o.service_id, s.name AS service_name, cat.name AS category_name,
         o.address_text, ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
         o.description, o.image_urls, o.scheduled_at, o.matching_mode,
         o.estimated_price, o.extra_amount, o.final_price,
         COALESCE(o.final_price, o.estimated_price + o.extra_amount) AS total_amount,
         o.created_at, o.accepted_at, o.started_at, o.completed_at, o.cancelled_at, o.cancel_reason,
         o.warranty_until,
         EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id) AS has_review,
         ${WORKER_BRIEF}
  FROM orders o
  JOIN services s ON s.id = o.service_id
  JOIN service_categories cat ON cat.id = s.category_id
  LEFT JOIN workers w ON w.user_id = o.worker_id
  LEFT JOIN users wu ON wu.id = o.worker_id`;

const GROUPS = {
  active: `o.status = ANY('{${ACTIVE_STATUSES.join(',')}}'::order_status[])`,
  completed: `o.status = 'completed'`,
  cancelled: `o.status = 'cancelled'`,
};

// ── Tạo đơn ─────────────────────────────────────────────────────────────────

export const createOrder = async (customerId, { serviceId, addressId, description, scheduledAt, matchingMode }) => {
  const orderId = await withTransaction(async (db) => {
    const { rows: svc } = await sql(
      db,
      `SELECT s.id, s.base_price FROM services s JOIN service_categories c ON c.id = s.category_id
       WHERE s.id = $1 AND s.is_active AND c.is_active`,
      [serviceId],
    );
    if (!svc[0]) throw new AppError(404, 'Dịch vụ không tồn tại hoặc đã ngừng cung cấp');

    const { rows: addr } = await sql(
      db,
      'SELECT address_text, location FROM customer_addresses WHERE id = $1 AND customer_id = $2',
      [addressId, customerId],
    );
    if (!addr[0]) throw new AppError(404, 'Không tìm thấy địa chỉ');

    const { rows: active } = await sql(
      db,
      `SELECT COUNT(*)::int AS n FROM orders o WHERE o.customer_id = $1 AND ${GROUPS.active}`,
      [customerId],
    );
    if (active[0].n >= 5) throw new AppError(400, 'Bạn đang có quá nhiều đơn chưa hoàn thành');

    // [B] Trả tiền qua app sau khi thợ làm xong: còn đơn hoàn thành chưa thanh toán thì chưa đặt đơn mới
    const { rows: unpaid } = await sql(
      db,
      `SELECT o.code FROM orders o
       WHERE o.customer_id = $1 AND o.status = 'completed'
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'success')
       ORDER BY o.completed_at LIMIT 1`,
      [customerId],
    );
    if (unpaid[0]) {
      throw new AppError(400, `Bạn chưa thanh toán đơn ${unpaid[0].code}. Vui lòng thanh toán trước khi đặt đơn mới`);
    }

    const config = await getConfig(db);

    // Mã đơn dạng TN2610170000123 (ngày theo giờ VN + id)
    const { rows } = await sql(
      db,
      `WITH nid AS (SELECT nextval(pg_get_serial_sequence('orders', 'id')) AS id)
       INSERT INTO orders (id, code, customer_id, service_id, address_text, location, description,
                           scheduled_at, status, matching_mode, matching_config_id, estimated_price)
       SELECT nid.id,
              'TN' || to_char(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYMMDD') || lpad(nid.id::text, 6, '0'),
              $1, $2, $3, $4, $5, $6, 'matching', $7, $8, $9
       FROM nid
       RETURNING id`,
      [customerId, serviceId, addr[0].address_text, addr[0].location, description, scheduledAt,
        matchingMode, config.id, svc[0].base_price],
    );
    const id = rows[0].id;
    await addHistory(db, id, null, 'pending', customerId, 'Khách tạo đơn');
    await addHistory(db, id, 'pending', 'matching', customerId, 'Bắt đầu tìm thợ');
    return id;
  });

  // Gửi đề xuất cho thợ sau khi đơn đã lưu (lỗi ở bước này không làm mất đơn)
  try {
    await dispatchOffers(orderId);
  } catch (err) {
    console.error('dispatchOffers failed', err);
  }
  return getOrderDetail(customerId, orderId);
};

// ── Danh sách / chi tiết ────────────────────────────────────────────────────

export const listOrders = async (customerId, { group, pageSize, offset }) => {
  const { rows } = await q(
    `${ORDER_SELECT.replace('SELECT o.id', 'SELECT COUNT(*) OVER()::int AS total, o.id')}
     WHERE o.customer_id = $1 AND ${group ? GROUPS[group] : 'TRUE'}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $2 OFFSET $3`,
    [customerId, pageSize, offset],
  );
  return { items: rows.map(({ total, ...o }) => o), total: rows[0]?.total ?? 0 };
};

export const getOrderDetail = async (customerId, id) => {
  const { rows } = await q(`${ORDER_SELECT} WHERE o.id = $1 AND o.customer_id = $2`, [id, customerId]);
  let order = rows[0];
  if (!order) throw new AppError(404, 'Không tìm thấy đơn hàng');

  if (order.status === 'matching') {
    await refreshOffers(id).catch((err) => console.error('refreshOffers failed', err));
  }

  const [history, quotes, payments, review, offers, warrantyClaim] = await Promise.all([
    q(
      `SELECT from_status, to_status, note, created_at FROM order_status_history
       WHERE order_id = $1 ORDER BY created_at, id`,
      [id],
    ),
    q(
      `SELECT id, description, amount, image_urls, status, created_at, responded_at
       FROM order_extra_quotes WHERE order_id = $1 ORDER BY created_at`,
      [id],
    ),
    q(
      `SELECT id, method, amount, status, provider_txn_id, created_at, paid_at
       FROM payments WHERE order_id = $1 ORDER BY created_at`,
      [id],
    ),
    q('SELECT id, rating, comment, created_at FROM reviews WHERE order_id = $1', [id]),
    q(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'offered')::int AS waiting
       FROM order_offers WHERE order_id = $1`,
      [id],
    ),
    q(
      `SELECT id, status, created_at FROM complaints
       WHERE order_id = $1 AND type = 'warranty' ORDER BY created_at DESC LIMIT 1`,
      [id],
    ),
  ]);

  const paidOk = payments.rows.some((p) => p.status === 'success');
  const claim = warrantyClaim.rows[0] ?? null;
  const claimOpen = claim && ['open', 'processing'].includes(claim.status);
  const warrantyActive = !!order.warranty_until && new Date(order.warranty_until) > new Date();

  return {
    ...order,
    offers: offers.rows[0],
    history: history.rows,
    extra_quotes: quotes.rows,
    payments: payments.rows,
    review: review.rows[0] ?? null,
    warranty: order.warranty_until
      ? { until: order.warranty_until, active: warrantyActive, claim_status: claim?.status ?? null }
      : null,
    can_cancel: CANCELLABLE_STATUSES.includes(order.status),
    can_pay: order.status === 'completed' && !paidOk, // [B] không còn chờ thợ xác nhận tiền mặt
    can_review: order.status === 'completed' && !order.has_review && !!order.worker,
    can_claim_warranty: order.status === 'completed' && warrantyActive && !claimOpen,
    can_complain: !!order.worker && order.status !== 'cancelled',
  };
};

// ── Huỷ đơn ─────────────────────────────────────────────────────────────────

export const cancelOrder = async (customerId, id, reason) => {
  const order = await withTransaction(async (db) => {
    const o = await getOwnedOrder(db, id, customerId, true);
    if (!CANCELLABLE_STATUSES.includes(o.status)) {
      throw new AppError(400, 'Thợ đã lên đường tới chỗ bạn nên không thể huỷ đơn. Vui lòng liên hệ CSKH');
    }
    await sql(
      db,
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2,
              cancel_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, customerId, reason],
    );
    await addHistory(db, id, o.status, 'cancelled', customerId, reason);
    // [B] reason 'closed': không tính là thợ bỏ lỡ; trả về để báo app thợ gỡ lời mời ngay
    const { rows: closed } = await sql(
      db,
      `UPDATE order_offers SET status = 'expired', responded_at = NOW(), reason = 'closed'
       WHERE order_id = $1 AND status = 'offered' RETURNING id, worker_id`,
      [id],
    );
    // [B] tính lại cờ bận (thợ có thể còn lịch hẹn khác sắp tới) thay vì đặt thẳng FALSE
    if (o.worker_id) await refreshAvailability(db, o.worker_id);
    return { ...o, status: 'cancelled', closedOffers: closed };
  });

  for (const f of order.closedOffers) emitToUser(Number(f.worker_id), 'offer:closed', { offer_id: Number(f.id), order_id: Number(order.id) }); // [B]
  emitOrderUpdated(order);
  if (order.worker_id) {
    await notify(order.worker_id, {
      title: 'Khách đã huỷ đơn',
      body: `Đơn ${order.code}: ${reason}`,
      type: 'order',
      data: { order_id: order.id },
    });
  }
  return { id: order.id, status: order.status };
};

// ── Theo dõi vị trí thợ ─────────────────────────────────────────────────────

export const getTracking = async (customerId, id) => {
  const { rows } = await q(
    `SELECT o.id AS order_id, o.status,
            ST_Y(o.location::geometry) AS destination_lat, ST_X(o.location::geometry) AS destination_lng,
            CASE WHEN show THEN ST_Y(w.current_location::geometry) END AS worker_lat,
            CASE WHEN show THEN ST_X(w.current_location::geometry) END AS worker_lng,
            CASE WHEN show THEN w.location_updated_at END AS location_updated_at
     FROM orders o
     LEFT JOIN workers w ON w.user_id = o.worker_id
     CROSS JOIN LATERAL (SELECT o.status IN ('accepted', 'on_the_way', 'arrived', 'in_progress') AS show) v
     WHERE o.id = $1 AND o.customer_id = $2`,
    [id, customerId],
  );
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy đơn hàng');
  return rows[0];
};

// ── Báo giá phát sinh ───────────────────────────────────────────────────────

export const respondQuote = async (customerId, orderId, quoteId, approve) => {
  const result = await withTransaction(async (db) => {
    const o = await getOwnedOrder(db, orderId, customerId, true);
    if (!['accepted', 'on_the_way', 'arrived', 'in_progress'].includes(o.status)) {
      throw new AppError(400, 'Đơn không còn ở trạng thái nhận báo giá');
    }
    const { rows } = await sql(
      db,
      `UPDATE order_extra_quotes SET status = $3, responded_at = NOW()
       WHERE id = $1 AND order_id = $2 AND status = 'pending'
       RETURNING id, description, amount, status, created_at, responded_at`,
      [quoteId, orderId, approve ? 'approved' : 'rejected'],
    );
    if (!rows[0]) throw new AppError(404, 'Báo giá không tồn tại hoặc đã được xử lý');

    const { rows: upd } = await sql(
      db,
      `UPDATE orders SET extra_amount = extra_amount + $2, updated_at = NOW() WHERE id = $1
       RETURNING estimated_price + extra_amount AS total_amount`,
      [orderId, approve ? rows[0].amount : 0],
    );
    return { order: o, quote: rows[0], total_amount: upd[0].total_amount };
  });

  emitOrderUpdated(result.order);
  await notify(result.order.worker_id, {
    title: approve ? 'Khách đồng ý báo giá' : 'Khách từ chối báo giá',
    body: `${result.quote.description} · ${result.quote.amount.toLocaleString('vi-VN')}đ`,
    type: 'quote',
    data: { order_id: result.order.id, quote_id: result.quote.id },
  });
  return { ...result.quote, total_amount: result.total_amount };
};
