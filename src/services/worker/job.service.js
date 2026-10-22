/**
 * App thợ: lời mời nhận đơn (offer) và toàn bộ quá trình thực hiện đơn.  [Thành viên B]
 *
 * Luồng trạng thái phía thợ:  accepted -> on_the_way -> arrived -> in_progress -> completed
 *   - Đơn hẹn trước chỉ được bắt đầu di chuyển trong vòng 60 phút trước giờ hẹn
 *   - Bắt đầu sửa phải xác nhận đã kiểm tra an toàn điện
 *   - Báo giá phát sinh chỉ sau khi đến nơi xem hiện trạng; hoàn thành cần >= 1 ảnh sau khi sửa
 *     và không còn báo giá chờ khách duyệt
 */
import { pool, q, sql } from '../../config/db.js';
import { settings } from '../../config/worker.js';
import { AppError } from '../../utils/AppError.js';
import { transaction } from '../../utils/tx.js';
import { givenName, money, vnClock, vnTime } from '../../utils/vn.js';
import { addHistory } from '../customer/common.js';
import { emitOrderUpdated, notify } from '../customer/notify.service.js';
import * as dispatch from '../matching/dispatch.service.js';
import { OPEN_JOB_STATUSES, commissionOf, refreshAvailability } from './state.js';

export const NEXT_STATUS = { accepted: 'on_the_way', on_the_way: 'arrived', arrived: 'in_progress', in_progress: 'completed' };
const NEXT_ACTION = {
  on_the_way: 'Bắt đầu di chuyển',
  arrived: 'Tôi đã đến nơi',
  in_progress: 'Bắt đầu sửa chữa',
  completed: 'Hoàn thành công việc',
};
const CUSTOMER_TEXT = {
  on_the_way: (o, name) => ['Thợ đang tới', `${name} đang trên đường tới chỗ bạn`],
  arrived: (o, name) => ['Thợ đã đến nơi', `${name} đã tới địa chỉ của bạn, bạn ra đón thợ nhé`],
  in_progress: (o) => ['Bắt đầu sửa chữa', `Đơn ${o.code} đang được thực hiện`],
  completed: (o, name, total) => ['Đơn đã hoàn thành', `Đơn ${o.code} đã xong, tổng tiền ${money(total)}. Vui lòng thanh toán và đánh giá thợ`],
};
export const JOB_GROUPS = {
  active: OPEN_JOB_STATUSES,
  completed: ['completed'],
  cancelled: ['cancelled'],
  history: ['completed', 'cancelled'],
};
const CHAT_STATUSES = ['accepted', 'on_the_way', 'arrived', 'in_progress', 'completed'];
const QUOTE_STATUSES = ['arrived', 'in_progress']; // báo giá phát sinh chỉ sau khi đã đến nơi
const PHOTO_STATUSES = { before: ['arrived', 'in_progress'], after: ['in_progress'] };
const MAX_PHOTOS_PER_KIND = 6;
const PHONE_VISIBLE_DAYS_AFTER = 7;
const REPORT_PREFIX = '[Thợ báo cáo] ';

// ═════════════════════════════════════════════════════════════════════════
// Offer
// ═════════════════════════════════════════════════════════════════════════

const OFFER_SQL = `
  SELECT f.id, f.order_id, f.status, f.round, f.mode, f.offered_at, f.expires_at,
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM f.expires_at - NOW())))::int AS expires_in_seconds,
         ROUND(EXTRACT(EPOCH FROM f.expires_at - f.offered_at))::int AS timeout_seconds,
         f.score AS match_score, f.distance_km,
         o.code, o.service_id, s.name AS service_name, c.name AS category_name, o.description, o.image_urls,
         o.address_text, ST_Y(o.location::geometry) AS latitude, ST_X(o.location::geometry) AS longitude,
         o.scheduled_at, o.estimated_price, u.full_name AS customer_full_name
  FROM order_offers f
  JOIN orders o ON o.id = f.order_id
  JOIN services s ON s.id = o.service_id
  JOIN service_categories c ON c.id = s.category_id
  JOIN users u ON u.id = o.customer_id`;

const offerOut = ({ customer_full_name, ...f }) => ({
  ...f,
  estimated_earning: f.estimated_price - commissionOf(f.estimated_price),
  commission_rate: settings.commissionRate,
  customer_name: givenName(customer_full_name), // chưa nhận đơn: chỉ hiện tên gọi
});

/** Lời mời đang chờ thợ trả lời (null nếu không có) */
export async function currentOffer(workerId) {
  const { rows } = await q(
    `${OFFER_SQL}
     WHERE f.worker_id = $1 AND f.status = 'offered' AND f.expires_at > NOW() AND o.status = 'matching'
     ORDER BY f.offered_at DESC LIMIT 1`,
    [workerId],
  );
  return rows[0] ? offerOut(rows[0]) : null;
}

export async function acceptOffer(workerId, offerId) {
  const orderId = await dispatch.acceptOffer(workerId, offerId);
  return jobDetail(workerId, orderId);
}

export const rejectOffer = (workerId, offerId, reason) => dispatch.rejectOffer(workerId, offerId, reason);

// ═════════════════════════════════════════════════════════════════════════
// Danh sách / chi tiết đơn
// ═════════════════════════════════════════════════════════════════════════

const ITEM_SQL = `
  SELECT o.id, o.code, o.status, o.service_id, s.name AS service_name, c.name AS category_name, o.address_text,
         ST_Y(o.location::geometry) AS latitude, ST_X(o.location::geometry) AS longitude,
         o.scheduled_at, o.created_at, o.accepted_at, o.started_at, o.completed_at, o.cancelled_at,
         o.estimated_price, o.extra_amount, o.final_price,
         COALESCE(o.final_price, o.estimated_price + o.extra_amount) AS total_amount,
         o.customer_id, cu.full_name AS customer_name,
         pay.id IS NOT NULL AS paid, pay.method AS payment_method,
         CASE WHEN pay.id IS NOT NULL
              THEN pay.amount - COALESCE(o.commission_amount, ROUND(pay.amount * $2)) END AS net_earning,
         (SELECT COUNT(*) FROM messages m
          WHERE m.order_id = o.id AND m.sender_id <> $1 AND m.read_at IS NULL)::int AS unread_messages,
         r.rating
  FROM orders o
  JOIN services s ON s.id = o.service_id
  JOIN service_categories c ON c.id = s.category_id
  JOIN users cu ON cu.id = o.customer_id
  LEFT JOIN LATERAL (SELECT p.id, p.method, p.amount FROM payments p
                     WHERE p.order_id = o.id AND p.status = 'success' ORDER BY p.paid_at DESC LIMIT 1) pay ON TRUE
  LEFT JOIN reviews r ON r.order_id = o.id`;

/** Thẻ đơn cho danh sách, giữ đúng thứ tự ids truyền vào */
export async function jobItems(workerId, ids) {
  if (!ids.length) return [];
  const { rows } = await q(`${ITEM_SQL} WHERE o.worker_id = $1 AND o.id = ANY($3::bigint[])`, [workerId, settings.commissionRate, ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.map((id) => byId.get(Number(id))).filter(Boolean);
}

export async function listJobs(workerId, group, { pageSize, offset }) {
  const order =
    group === 'active'
      ? 'o.scheduled_at ASC NULLS FIRST, o.accepted_at DESC'
      : 'COALESCE(o.completed_at, o.cancelled_at, o.created_at) DESC, o.id DESC';
  const { rows } = await q(
    `SELECT t.*, COUNT(*) OVER()::int AS total FROM (${ITEM_SQL}
       WHERE o.worker_id = $1 AND o.status = ANY($3::order_status[])) t
     ORDER BY ${order.replaceAll('o.', 't.')}
     LIMIT $4 OFFSET $5`,
    [workerId, settings.commissionRate, JOB_GROUPS[group], pageSize, offset],
  );
  return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

/** Đơn của chính thợ (khoá dòng nếu forUpdate). Không phải của thợ => 404 */
async function ownJob(db, workerId, orderId, forUpdate = false) {
  const { rows } = await sql(db, `SELECT * FROM orders WHERE id = $1 AND worker_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`, [
    orderId,
    workerId,
  ]);
  if (!rows[0]) throw new AppError(404, 'Không tìm thấy đơn');
  return rows[0];
}

/** Đơn hẹn trước chỉ được bắt đầu di chuyển trong vòng 60 phút trước giờ hẹn */
const tripStartAt = (o) =>
  o.status === 'accepted' && o.scheduled_at
    ? new Date(new Date(o.scheduled_at).getTime() - settings.busyBeforeScheduleMinutes * 60_000)
    : null;

export async function jobDetail(workerId, orderId) {
  const [item] = await jobItems(workerId, [orderId]);
  if (!item) throw new AppError(404, 'Không tìm thấy đơn');

  const [extra, photos, quotes, payments, history, review, report, claim] = await Promise.all([
    q(
      `SELECT o.description, o.image_urls, o.cancel_reason, o.safety_checked_at, o.warranty_until,
              u.id AS customer_id, u.full_name, u.phone, u.avatar_url, s.warranty_days,
              ROUND((ST_Distance(w.current_location, o.location) / 1000)::numeric, 2) AS distance_km
       FROM orders o JOIN users u ON u.id = o.customer_id JOIN services s ON s.id = o.service_id
       LEFT JOIN workers w ON w.user_id = $2
       WHERE o.id = $1`,
      [orderId, workerId],
    ),
    q('SELECT id, kind, url, created_at FROM order_photos WHERE order_id = $1 ORDER BY id', [orderId]),
    q(
      'SELECT id, description, amount, image_urls, status, created_at, responded_at FROM order_extra_quotes WHERE order_id = $1 ORDER BY created_at, id',
      [orderId],
    ),
    q(
      `SELECT id, amount, method, status, provider_txn_id AS transaction_code, created_at, paid_at
       FROM payments WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    ),
    q(
      `SELECT from_status, to_status AS status, note, created_at FROM order_status_history
       WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    ),
    q('SELECT rating, comment, image_urls, created_at FROM reviews WHERE order_id = $1', [orderId]),
    q(
      "SELECT 1 FROM complaints WHERE order_id = $1 AND reporter_id = $2 AND status IN ('open', 'processing') LIMIT 1",
      [orderId, workerId],
    ),
    q("SELECT status FROM complaints WHERE order_id = $1 AND type = 'warranty' ORDER BY created_at DESC LIMIT 1", [orderId]),
  ]);
  const x = extra.rows[0];
  const now = Date.now();
  const phoneVisible =
    OPEN_JOB_STATUSES.includes(item.status) ||
    (item.status === 'completed' && item.completed_at && now - new Date(item.completed_at).getTime() <= PHONE_VISIBLE_DAYS_AFTER * 86_400_000);
  const pendingQuote = quotes.rows.some((qq) => qq.status === 'pending');
  const hasAfter = photos.rows.some((p) => p.kind === 'after');
  const success = payments.rows.find((p) => p.status === 'success');
  const next = NEXT_STATUS[item.status] ?? null;
  const startAt = tripStartAt(item);
  const total = item.total_amount;
  const commission = success ? success.amount - item.net_earning : null;

  return {
    ...item,
    description: x.description,
    image_urls: x.image_urls,
    cancel_reason: x.cancel_reason,
    customer: { id: x.customer_id, full_name: x.full_name, phone: phoneVisible ? x.phone : null, avatar_url: x.avatar_url },
    distance_km: x.distance_km,
    history: history.rows,
    photos: photos.rows,
    extra_quotes: quotes.rows,
    payments: payments.rows,
    review: review.rows[0] ?? null,
    warranty:
      item.status === 'completed' && x.warranty_until
        ? {
            terms: `Bảo hành ${x.warranty_days} ngày cho hạng mục "${item.service_name}"`,
            start_date: item.completed_at,
            end_date: x.warranty_until,
            status: new Date(x.warranty_until).getTime() > now ? 'active' : 'expired',
            claim_status: claim.rows[0]?.status ?? null,
          }
        : null,
    earning: success ? { gross_amount: success.amount, commission_amount: commission, net_amount: item.net_earning } : null,
    estimated_earning: total - commissionOf(total),
    next_status: next,
    next_action: next ? NEXT_ACTION[next] : null,
    can_cancel: ['accepted', 'on_the_way', 'arrived'].includes(item.status),
    cancel_requeues: ['accepted', 'on_the_way'].includes(item.status),
    can_quote: QUOTE_STATUSES.includes(item.status) && !pendingQuote,
    can_add_photos: ['arrived', 'in_progress'].includes(item.status),
    can_chat: CHAT_STATUSES.includes(item.status),
    can_report: !report.rows.length,
    needs_after_photo: item.status === 'in_progress' && !hasAfter,
    needs_safety_check: item.status === 'arrived',
    safety_checked_at: x.safety_checked_at,
    start_available_at: startAt && now < startAt.getTime() ? startAt : null,
    has_pending_quote: pendingQuote,
    // Khách trả qua app (MoMo / VNPay) sau khi thợ hoàn thành; thợ không thu tiền mặt
    awaiting_payment: item.status === 'completed' && !item.paid,
    amount_due: item.status === 'completed' && !item.paid ? total : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Cập nhật tiến độ
// ═════════════════════════════════════════════════════════════════════════

export async function advanceStatus(workerId, orderId, status, safetyConfirmed) {
  await transaction(async (db, after) => {
    const o = await ownJob(db, workerId, orderId, true);
    if (NEXT_STATUS[o.status] !== status) {
      if (o.status === status) throw new AppError(409, 'Đơn đã ở trạng thái này rồi');
      throw new AppError(400, 'Không thể chuyển sang trạng thái này ở bước hiện tại');
    }
    const startAt = tripStartAt(o);
    if (status === 'on_the_way' && startAt && Date.now() < startAt.getTime()) {
      throw new AppError(400, `Đơn hẹn lúc ${vnTime(o.scheduled_at)}. Bạn có thể bắt đầu di chuyển từ ${vnClock(startAt)}.`);
    }

    let total = null;
    if (status === 'in_progress') {
      if (!safetyConfirmed) {
        throw new AppError(400, 'Hãy xác nhận đã kiểm tra an toàn điện (ngắt nguồn, thử điện, đồ bảo hộ, báo khách) trước khi bắt đầu sửa');
      }
      await sql(
        db,
        "UPDATE orders SET status = 'in_progress', started_at = NOW(), safety_checked_at = NOW(), updated_at = NOW() WHERE id = $1",
        [orderId],
      );
    } else if (status === 'completed') {
      const { rows: pq } = await sql(db, "SELECT 1 FROM order_extra_quotes WHERE order_id = $1 AND status = 'pending' LIMIT 1", [orderId]);
      if (pq.length) throw new AppError(400, 'Còn báo giá phát sinh chờ khách duyệt. Hãy chờ khách trả lời hoặc rút lại báo giá.');
      const { rows: ph } = await sql(db, "SELECT 1 FROM order_photos WHERE order_id = $1 AND kind = 'after' LIMIT 1", [orderId]);
      if (!ph.length) throw new AppError(400, 'Cần chụp ít nhất 1 ảnh sau khi sửa để hoàn thành');
      const { rows } = await sql(
        db,
        `UPDATE orders o SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
           final_price = o.estimated_price + o.extra_amount,
           warranty_until = CASE WHEN s.warranty_days > 0 THEN NOW() + make_interval(days => s.warranty_days) END
         FROM services s WHERE s.id = o.service_id AND o.id = $1
         RETURNING o.final_price`,
        [orderId],
      );
      total = rows[0].final_price;
      await sql(db, 'UPDATE workers SET total_jobs = total_jobs + 1, updated_at = NOW() WHERE user_id = $1', [workerId]);
    } else {
      await sql(db, 'UPDATE orders SET status = $2::order_status, updated_at = NOW() WHERE id = $1', [orderId, status]);
    }
    await addHistory(db, orderId, o.status, status, workerId);
    await refreshAvailability(db, workerId);

    const { rows: me } = await sql(db, 'SELECT full_name FROM users WHERE id = $1', [workerId]);
    after(async () => {
      const [title, body] = CUSTOMER_TEXT[status](o, me[0].full_name, total);
      emitOrderUpdated({ ...o, status });
      await notify(o.customer_id, { title, body, type: 'order', data: { order_id: o.id } });
    });
  });
  return jobDetail(workerId, orderId);
}

export async function cancelJob(workerId, orderId, reason) {
  let requeueMode = null;
  const status = await transaction(async (db, after) => {
    const o = await ownJob(db, workerId, orderId, true);
    if (['accepted', 'on_the_way'].includes(o.status)) {
      // Chưa tới nơi: trả đơn về hàng đợi để hệ thống tìm thợ khác (không mời lại thợ này)
      requeueMode = await dispatch.requeueAfterWorkerCancel(db, after, o, workerId, reason);
      await refreshAvailability(db, workerId);
      return 'matching';
    }
    if (o.status === 'arrived') {
      await sql(
        db,
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3, updated_at = NOW()
         WHERE id = $1`,
        [orderId, workerId, `[Thợ] ${reason}`],
      );
      await addHistory(db, orderId, o.status, 'cancelled', workerId, `Thợ huỷ: ${reason}`);
      await sql(
        db,
        "UPDATE order_offers SET status = 'cancelled', responded_at = NOW(), reason = $3 WHERE order_id = $1 AND worker_id = $2",
        [orderId, workerId, reason],
      );
      await sql(db, "UPDATE order_extra_quotes SET status = 'cancelled', responded_at = NOW() WHERE order_id = $1 AND status = 'pending'", [orderId]);
      await refreshAvailability(db, workerId);
      after(async () => {
        emitOrderUpdated({ ...o, status: 'cancelled' });
        await notify(o.customer_id, { title: 'Đơn đã bị huỷ', body: `Thợ đã huỷ đơn ${o.code}: ${reason}`, type: 'order', data: { order_id: o.id } });
      });
      return 'cancelled';
    }
    if (o.status === 'in_progress') throw new AppError(400, 'Đang sửa thì không huỷ được. Nếu có vấn đề, hãy dùng Báo cáo sự cố.');
    throw new AppError(400, 'Đơn không còn huỷ được');
  });
  if (requeueMode === 'instant') await dispatch.runInstantWave(orderId);
  return { id: orderId, status };
}

// ═════════════════════════════════════════════════════════════════════════
// Ảnh trước / sau
// ═════════════════════════════════════════════════════════════════════════

export async function addPhotos(workerId, orderId, kind, urls) {
  await transaction(async (db) => {
    const o = await ownJob(db, workerId, orderId, true);
    if (!PHOTO_STATUSES[kind].includes(o.status)) {
      throw new AppError(400, `Chưa thể thêm ảnh ${kind === 'before' ? 'trước khi sửa' : 'sau khi sửa'} ở bước này`);
    }
    const { rows } = await sql(db, 'SELECT COUNT(*)::int AS n FROM order_photos WHERE order_id = $1 AND kind = $2', [orderId, kind]);
    if (rows[0].n + urls.length > MAX_PHOTOS_PER_KIND) throw new AppError(400, `Tối đa ${MAX_PHOTOS_PER_KIND} ảnh mỗi loại`);
    for (const url of urls) {
      await sql(db, 'INSERT INTO order_photos (order_id, uploader_id, kind, url) VALUES ($1, $2, $3, $4)', [orderId, workerId, kind, url]);
    }
  });
  return jobDetail(workerId, orderId);
}

export async function deletePhoto(workerId, orderId, photoId) {
  const o = await ownJob(pool, workerId, orderId);
  if (['completed', 'cancelled'].includes(o.status)) throw new AppError(400, 'Đơn đã đóng, không xoá được ảnh');
  const { rowCount } = await q('DELETE FROM order_photos WHERE id = $1 AND order_id = $2', [photoId, orderId]);
  if (!rowCount) throw new AppError(404, 'Không tìm thấy ảnh');
  return jobDetail(workerId, orderId);
}

// ═════════════════════════════════════════════════════════════════════════
// Báo giá phát sinh (khách duyệt trên app khách: /api/customer/orders/:id/quotes/:quoteId/approve|reject)
// ═════════════════════════════════════════════════════════════════════════

export async function createQuote(workerId, orderId, description, amount) {
  await transaction(async (db, after) => {
    const o = await ownJob(db, workerId, orderId, true);
    if (!QUOTE_STATUSES.includes(o.status)) {
      if (['accepted', 'on_the_way'].includes(o.status)) throw new AppError(400, 'Hãy đến nơi xem hiện trạng rồi mới báo giá phát sinh');
      throw new AppError(400, 'Đơn không còn nhận báo giá phát sinh');
    }
    const { rows: pq } = await sql(db, "SELECT 1 FROM order_extra_quotes WHERE order_id = $1 AND status = 'pending' LIMIT 1", [orderId]);
    if (pq.length) throw new AppError(400, 'Đang có 1 báo giá chờ khách duyệt');
    const { rows } = await sql(
      db,
      'INSERT INTO order_extra_quotes (order_id, worker_id, description, amount) VALUES ($1, $2, $3, $4) RETURNING id',
      [orderId, workerId, description, amount],
    );
    after(async () => {
      emitOrderUpdated(o);
      await notify(o.customer_id, {
        title: 'Thợ gửi báo giá phát sinh',
        body: `${description.split('\n')[0]} · ${money(amount)}. Vui lòng xác nhận để thợ tiếp tục.`,
        type: 'quote',
        data: { order_id: o.id, quote_id: rows[0].id },
      });
    });
  });
  return jobDetail(workerId, orderId);
}

export async function cancelQuote(workerId, orderId, quoteId) {
  await transaction(async (db, after) => {
    const o = await ownJob(db, workerId, orderId, true);
    const { rows } = await sql(db, 'SELECT id, status, description FROM order_extra_quotes WHERE id = $1 AND order_id = $2 FOR UPDATE', [
      quoteId,
      orderId,
    ]);
    const quote = rows[0];
    if (!quote) throw new AppError(404, 'Không tìm thấy báo giá');
    if (quote.status !== 'pending') throw new AppError(400, 'Khách đã trả lời báo giá này');
    await sql(db, "UPDATE order_extra_quotes SET status = 'cancelled', responded_at = NOW() WHERE id = $1", [quoteId]);
    after(async () => {
      emitOrderUpdated(o);
      await notify(o.customer_id, {
        title: 'Thợ đã rút lại báo giá phát sinh',
        body: `Đơn ${o.code}: ${quote.description.split('\n')[0]}`,
        type: 'quote',
        data: { order_id: o.id, quote_id: quote.id },
      });
    });
  });
  return jobDetail(workerId, orderId);
}

// ═════════════════════════════════════════════════════════════════════════
// Báo cáo sự cố (đi vào luồng khiếu nại của admin)
// ═════════════════════════════════════════════════════════════════════════

const reportOut = ({ title, content, ...c }) => ({
  ...c,
  reason: title.startsWith(REPORT_PREFIX) ? title.slice(REPORT_PREFIX.length) : title,
  description: content,
});

export async function createReport(workerId, orderId, reason, description) {
  const o = await ownJob(pool, workerId, orderId);
  const { rows: open } = await q(
    "SELECT 1 FROM complaints WHERE order_id = $1 AND reporter_id = $2 AND status IN ('open', 'processing') LIMIT 1",
    [orderId, workerId],
  );
  if (open.length) throw new AppError(400, 'Bạn đã báo cáo đơn này, đang chờ xử lý');
  const { rows } = await q(
    `INSERT INTO complaints (order_id, customer_id, type, title, content, reporter_id)
     VALUES ($1, $2, 'complaint', $3, $4, $5)
     RETURNING id, order_id, title, content, status, resolution, created_at, resolved_at`,
    [orderId, o.customer_id, `${REPORT_PREFIX}${reason}`, description || reason, workerId],
  );
  return reportOut({ ...rows[0], code: o.code });
}

export async function listReports(workerId, { pageSize, offset }) {
  const { rows } = await q(
    `SELECT c.id, c.order_id, o.code, c.title, c.content, c.status, c.resolution, c.created_at, c.resolved_at,
            COUNT(*) OVER()::int AS total
     FROM complaints c JOIN orders o ON o.id = c.order_id
     WHERE c.reporter_id = $1 ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
    [workerId, pageSize, offset],
  );
  return { items: rows.map(({ total, ...c }) => reportOut(c)), total: rows[0]?.total ?? 0 };
}
