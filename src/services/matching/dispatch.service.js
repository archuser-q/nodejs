/**
 * Bộ điều phối đơn — đưa thuật toán ghép cặp vào vận hành thật.  [Thành viên B]
 *
 * Vòng đời 1 đơn đang tìm thợ (orders.status = 'matching'):
 *
 *   khách tạo đơn ─> order_dispatches (hàng đợi) ─> gửi offer ─> thợ nhận ─> 'accepted'
 *                        ^                            │
 *                        └── hết hạn / từ chối ───────┘  (đơn quay lại hàng đợi, KHÔNG mời lại thợ cũ)
 *   quá hạn chờ (deadline) mà chưa ai nhận ─> hệ thống huỷ đơn, báo khách
 *
 * Ba chế độ (admin chọn ở cấu hình đang bật — matching_configs.mode):
 *  - instant: Weighted Scoring + Greedy theo đợt (wave): mỗi đợt xếp hạng ứng viên hợp lệ, gửi offer
 *             cho top-k (k = max_offers) cùng lúc, ai nhận trước được đơn; hết offer_timeout_seconds
 *             mà không ai nhận -> đợt tiếp theo cho các thợ xếp sau.
 *  - batch:   cứ batch_window_seconds gom TẤT CẢ đơn đang chờ + thợ rảnh thành ma trận điểm, giải bài
 *             toán gán 2 phía bằng Hungarian (matching/hungarian.js) để tối đa tổng điểm toàn cục;
 *             mỗi đơn được gán gửi offer cho đúng 1 thợ.
 *  - auto:    hệ thống TỰ CHỌN 1 trong 2 chế độ trên cho từng nhóm đơn, mỗi nhịp (vài giây):
 *             chia các đơn đang chờ thành nhóm tranh chấp (có chung thợ ứng viên, matching/grouping.js)
 *               · đơn đứng một mình -> Greedy top-k ngay (Hungarian 1 hàng = Greedy, không cần chờ lô)
 *               · nhóm >= 2 đơn     -> Hungarian trên nhóm (tối ưu toàn cục đúng chỗ có tranh chấp)
 *             orders.matching_mode / order_offers.mode ghi chế độ THỰC TẾ đã dùng ('instant' | 'batch').
 *
 * Ràng buộc cứng (lọc trước khi chấm điểm):
 *   hồ sơ đã duyệt, tài khoản hoạt động, có kỹ năng đúng danh mục, trong bán kính tìm của cấu hình VÀ
 *   bán kính nhận việc của thợ, vị trí còn mới, đang bật nhận đơn (đơn đặt ngay: phải rảnh),
 *   không đang giữ offer khác, chưa từng được mời đơn này, không trùng lịch.
 *
 * Các thao tác điều phối chạy tuần tự nhờ khoá advisory của PostgreSQL (DISPATCH_LOCK_KEY), nên 2 đơn
 * không thể cùng "giành" 1 thợ, kể cả khi chạy nhiều tiến trình API.
 */
import { pool, sql } from '../../config/db.js';
import { settings } from '../../config/worker.js';
import { AppError } from '../../utils/AppError.js';
import { transaction } from '../../utils/tx.js';
import { money, vnClock, vnTime } from '../../utils/vn.js';
import { emitToUser } from '../../realtime/socket.js';
import { addHistory } from '../customer/common.js';
import { emitOrderUpdated, notify } from '../customer/notify.service.js';
import { findCandidates } from '../candidate.js';
import { rankForDispatch } from '../../matching/scoring.js';
import { hungarianMax } from '../../matching/hungarian.js';
import { competitionGroups } from '../../matching/grouping.js';
import { getConfig, orderModeOf } from './config.js';
import { refreshWorkerStats } from './stats.js';
import {
  commissionOf,
  conflictingWorkers,
  hasInflightInstantJob,
  refreshAvailability,
} from '../worker/state.js';

export const DISPATCH_LOCK_KEY = 815001;
const lock = (db) => db.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_LOCK_KEY]);

const ORDER_SQL = `
  SELECT o.id, o.code, o.status, o.worker_id, o.customer_id, o.service_id, o.scheduled_at, o.created_at,
         o.estimated_price, o.address_text,
         ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
         s.category_id, s.name AS service_name
  FROM orders o JOIN services s ON s.id = o.service_id`;

const isFuture = (t) => !!t && new Date(t).getTime() > Date.now();

const deadlineOf = (order) => {
  const now = Date.now();
  if (isFuture(order.scheduled_at)) {
    const t = new Date(order.scheduled_at).getTime() - settings.scheduledCancelBeforeMinutes * 60_000;
    return new Date(Math.max(t, now + 5 * 60_000));
  }
  return new Date(now + settings.dispatchMaxWaitMinutes * 60_000);
};

const liveOfferExists = async (db, orderId) => {
  const { rows } = await sql(
    db,
    "SELECT 1 FROM order_offers WHERE order_id = $1 AND status = 'offered' AND expires_at > NOW() LIMIT 1",
    [orderId],
  );
  return rows.length > 0;
};

const emitOfferClosed = (rows) => {
  for (const r of rows) emitToUser(Number(r.worker_id), 'offer:closed', { offer_id: Number(r.id), order_id: Number(r.order_id) });
};

// ═════════════════════════════════════════════════════════════════════════
// Vào hàng đợi
// ═════════════════════════════════════════════════════════════════════════

/**
 * Đưa đơn vào hàng đợi điều phối (gọi sau khi khách tạo đơn — đơn đã COMMIT).
 * Chế độ do hệ thống quyết định theo cấu hình đang bật, không theo khách.
 * runNow: chế độ instant thì gửi đợt offer đầu tiên ngay.
 */
export async function enqueue(orderId, { runNow = true } = {}) {
  const cfg = await getConfig(pool);
  const queued = await transaction(async (db) => {
    const { rows } = await sql(db, `${ORDER_SQL} WHERE o.id = $1 FOR UPDATE OF o`, [orderId]);
    const o = rows[0];
    if (!o || o.status !== 'matching' || o.worker_id) return false;
    const { rowCount } = await sql(
      db,
      `INSERT INTO order_dispatches (order_id, mode, deadline_at) VALUES ($1, $2, $3)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, cfg.mode, deadlineOf(o)],
    );
    if (rowCount) {
      await sql(db, 'UPDATE orders SET matching_mode = $2, updated_at = NOW() WHERE id = $1', [orderId, orderModeOf(cfg.mode)]);
    }
    return rowCount > 0;
  });
  // auto: nhịp điều phối kế tiếp (<= vài giây) xử lý, để các đơn đến gần nhau được xét chung
  if (queued && runNow && cfg.mode === 'instant') return { offered: await runInstantWave(orderId, cfg) };
  return { offered: 0 };
}

/** Đơn 'matching' chưa có dòng hàng đợi (tạo bằng script / trước khi có module) -> nhận vào hàng đợi */
export async function adoptOrphans(cfg) {
  const { rowCount } = await sql(
    pool,
    `INSERT INTO order_dispatches (order_id, mode, deadline_at)
     SELECT o.id, $1,
            CASE WHEN o.scheduled_at > NOW()
                 THEN GREATEST(o.scheduled_at - make_interval(mins => $3), NOW() + interval '5 minutes')
                 ELSE NOW() + make_interval(mins => $2) END
     FROM orders o
     WHERE o.status = 'matching' AND o.worker_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM order_dispatches d WHERE d.order_id = o.id)
       AND (o.created_at >= NOW() - make_interval(mins => $2) OR o.scheduled_at > NOW())
     ON CONFLICT (order_id) DO NOTHING`,
    [cfg.mode, settings.dispatchMaxWaitMinutes, settings.scheduledCancelBeforeMinutes],
  );
  return rowCount;
}

// ═════════════════════════════════════════════════════════════════════════
// Lọc ứng viên hợp lệ + xếp hạng
// ═════════════════════════════════════════════════════════════════════════

/** Bước 2: áp ràng buộc cứng của nghiệp vụ lên danh sách đã lọc theo không gian (bước 1) */
async function filterEligible(db, order, candidates, when) {
  const freshAfter = settings.locationMaxAgeMinutes > 0 ? Date.now() - settings.locationMaxAgeMinutes * 60_000 : null;
  const list = candidates.filter(
    (c) =>
      c.distance_m <= Number(c.service_radius_km) * 1000 &&
      (!freshAfter || (c.location_updated_at && new Date(c.location_updated_at).getTime() >= freshAfter)),
  );
  if (!list.length) return [];

  const ids = list.map((c) => Number(c.id));
  const { rows } = await sql(
    db,
    `SELECT w.user_id AS id,
            EXISTS (SELECT 1 FROM order_offers f
                    WHERE f.worker_id = w.user_id AND f.status = 'offered' AND f.expires_at > NOW()) AS has_live_offer,
            EXISTS (SELECT 1 FROM order_offers f WHERE f.worker_id = w.user_id AND f.order_id = $2) AS offered_before
     FROM workers w WHERE w.user_id = ANY($1::bigint[])`,
    [ids, order.id],
  );
  const blocked = new Set(
    rows.filter((r) => r.has_live_offer || r.offered_before).map((r) => Number(r.id)),
  );
  // Đơn hẹn trước: lời mời ghi rõ giờ hẹn, thợ tự quyết; hệ thống chỉ chặn thợ đã có lịch trùng giờ
  const conflicts = await conflictingWorkers(db, ids.filter((id) => !blocked.has(id)), when, order.id);
  return list.filter((c) => !blocked.has(Number(c.id)) && !conflicts.has(Number(c.id)));
}

/** Bước 1 (không gian) -> bước 2 (ràng buộc cứng) -> bước 3 (Weighted Scoring, giảm dần) */
export async function rankForOrder(db, order, cfg) {
  const scheduled = isFuture(order.scheduled_at);
  const candidates = await findCandidates({
    lat: order.lat,
    lng: order.lng,
    categoryId: order.category_id,
    radiusKm: cfg.max_radius_km,
    includeBusy: scheduled, // đơn hẹn trước: thợ đang bận việc khác vẫn có thể nhận lịch sau
    db,
  });
  const eligible = await filterEligible(db, order, candidates, scheduled ? new Date(order.scheduled_at) : new Date());
  return rankForDispatch(eligible, cfg);
}

// ═════════════════════════════════════════════════════════════════════════
// Gửi offer
// ═════════════════════════════════════════════════════════════════════════

async function sendOffer(db, after, order, sw, cfg, { round, mode, rank }) {
  const { rows } = await sql(
    db,
    `INSERT INTO order_offers (order_id, worker_id, mode, score, distance_km, rank_position, round, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8))
     ON CONFLICT (order_id, worker_id) DO NOTHING
     RETURNING id, expires_at`,
    [order.id, sw.id, mode, sw.score.toFixed(5), (sw.distance_m / 1000).toFixed(3), rank, round, cfg.offer_timeout_seconds],
  );
  const offer = rows[0];
  if (!offer) return false;

  after(async () => {
    const price = Number(order.estimated_price) || 0;
    const when = isFuture(order.scheduled_at) ? `Hẹn ${vnTime(order.scheduled_at)}` : 'Làm ngay';
    await notify(sw.id, {
      title: `Đơn mới: ${order.service_name}`,
      body: `${(sw.distance_m / 1000).toFixed(1)} km · ${when} · thực nhận ~${money(price - commissionOf(price))}`,
      type: 'offer',
      data: { order_id: order.id, offer_id: offer.id },
    });
    emitToUser(sw.id, 'offer:new', { offer_id: offer.id, order_id: order.id, expires_at: offer.expires_at });
  });
  return true;
}

/** 1 đợt kiểu tức thời (Greedy): gửi offer cho top-k ứng viên đã xếp hạng (chưa commit) */
async function sendWave(db, after, order, dispatch, ranked, cfg) {
  const top = ranked.slice(0, Math.max(1, cfg.max_offers));
  if (!top.length) {
    await sql(
      db,
      `UPDATE order_dispatches SET last_attempt_at = NOW(), last_candidates = 0,
              next_attempt_at = NOW() + make_interval(secs => $2)
       WHERE order_id = $1`,
      [order.id, settings.dispatchRetrySeconds],
    );
    return 0;
  }
  const round = dispatch.rounds + 1;
  let sent = 0;
  for (const [i, sw] of top.entries()) {
    if (await sendOffer(db, after, order, sw, cfg, { round, mode: 'instant', rank: dispatch.offers_sent + i + 1 })) sent++;
  }
  await sql(
    db,
    `UPDATE order_dispatches SET rounds = rounds + 1, offers_sent = offers_sent + $2, last_attempt_at = NOW(),
            last_candidates = $3, next_attempt_at = NOW() + make_interval(secs => $4)
     WHERE order_id = $1`,
    [order.id, sent, ranked.length, cfg.offer_timeout_seconds],
  );
  await sql(db, "UPDATE orders SET matching_mode = 'instant', updated_at = NOW() WHERE id = $1", [order.id]);
  return sent;
}

/** Gửi 1 đợt offer cho 1 đơn (chế độ tức thời). Trả về số offer đã gửi. */
export async function runInstantWave(orderId, cfg = null) {
  return transaction(async (db, after) => {
    await lock(db);
    cfg = cfg ?? (await getConfig(db));
    const { rows } = await sql(db, `${ORDER_SQL} WHERE o.id = $1 FOR UPDATE OF o`, [orderId]);
    const order = rows[0];
    const { rows: drows } = await sql(db, 'SELECT * FROM order_dispatches WHERE order_id = $1', [orderId]);
    const dispatch = drows[0];
    if (!order || order.status !== 'matching' || order.worker_id || !dispatch) return 0;
    if (await liveOfferExists(db, orderId)) return 0;
    const ranked = await rankForOrder(db, order, cfg);
    return sendWave(db, after, order, dispatch, ranked, cfg);
  });
}

/** Các đơn chế độ instant tới lượt gửi đợt mới */
export async function runDueInstant(cfg) {
  const { rows } = await sql(
    pool,
    `SELECT d.order_id FROM order_dispatches d JOIN orders o ON o.id = d.order_id
     WHERE d.mode = 'instant' AND d.next_attempt_at <= NOW() AND o.status = 'matching' AND o.worker_id IS NULL
     ORDER BY d.created_at`,
  );
  let sent = 0;
  for (const r of rows) sent += await runInstantWave(r.order_id, cfg);
  return sent;
}

/** Đơn của 1 chế độ đang chờ ghép (tới lượt, không còn offer sống), khoá dòng để tiến trình khác bỏ qua */
async function loadWaiting(db, mode) {
  const { rows } = await sql(
    db,
    `${ORDER_SQL}
     JOIN order_dispatches d ON d.order_id = o.id
     WHERE d.mode = $1 AND d.next_attempt_at <= NOW() AND o.status = 'matching' AND o.worker_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM order_offers f
                       WHERE f.order_id = o.id AND f.status = 'offered' AND f.expires_at > NOW())
     ORDER BY o.id
     FOR UPDATE OF o SKIP LOCKED`,
    [mode],
  );
  if (!rows.length) return { orders: [], dispatches: new Map() };
  const { rows: ds } = await sql(db, 'SELECT * FROM order_dispatches WHERE order_id = ANY($1::bigint[])', [rows.map((o) => o.id)]);
  return { orders: rows, dispatches: new Map(ds.map((d) => [Number(d.order_id), d])) };
}

const emptyBatch = () => ({ orders: 0, workers: 0, assigned: 0, total_score: 0, solve_ms: 0, pairs: [] });

/**
 * Giải bài toán gán đơn x thợ bằng Hungarian; mỗi đơn được gán gửi đúng 1 offer (chưa commit).
 * rankedList[i] = danh sách ứng viên đã chấm điểm của orders[i].
 */
async function assignHungarian(db, after, orders, rankedList, dispatches, cfg, result) {
  const workerIds = [...new Set(rankedList.flatMap((r) => r.map((s) => Number(s.id))))];
  const byOrder = rankedList.map((r) => new Map(r.map((s) => [Number(s.id), s])));
  const matrix = byOrder.map((m) => workerIds.map((w) => m.get(w)?.score ?? null));

  const t0 = performance.now();
  const pairs = workerIds.length ? hungarianMax(matrix) : [];
  result.solve_ms += performance.now() - t0;
  result.workers += workerIds.length;

  const assigned = new Set();
  for (const [i, j] of pairs) {
    const order = orders[i];
    const sw = byOrder[i].get(workerIds[j]);
    const d = dispatches.get(Number(order.id));
    const ok = await sendOffer(db, after, order, sw, cfg, { round: d.rounds + 1, mode: 'batch', rank: d.offers_sent + 1 });
    if (!ok) continue;
    assigned.add(Number(order.id));
    await sql(
      db,
      `UPDATE order_dispatches SET rounds = rounds + 1, offers_sent = offers_sent + 1,
              next_attempt_at = NOW() + make_interval(secs => $2)
       WHERE order_id = $1`,
      [order.id, cfg.offer_timeout_seconds],
    );
    await sql(db, "UPDATE orders SET matching_mode = 'batch', updated_at = NOW() WHERE id = $1", [order.id]);
    result.pairs.push([Number(order.id), Number(sw.id)]);
    result.total_score += sw.score;
  }
  for (const [i, order] of orders.entries()) {
    // Đơn chưa được gán thì xét lại ở lượt sau (next_attempt_at giữ nguyên = đã tới hạn)
    await sql(db, 'UPDATE order_dispatches SET last_attempt_at = NOW(), last_candidates = $2 WHERE order_id = $1', [
      order.id,
      rankedList[i].length,
    ]);
  }
  result.assigned += assigned.size;
}

/** 1 lượt ghép theo lô (Hungarian) cho mọi đơn chế độ batch đang chờ */
export async function runBatchRound(cfg = null) {
  return transaction(async (db, after) => {
    await lock(db);
    cfg = cfg ?? (await getConfig(db));
    const { orders, dispatches } = await loadWaiting(db, 'batch');
    const result = emptyBatch();
    result.orders = orders.length;
    if (!orders.length) return result;
    const ranked = [];
    for (const o of orders) ranked.push(await rankForOrder(db, o, cfg));
    await assignHungarian(db, after, orders, ranked, dispatches, cfg, result);
    return result;
  });
}

/**
 * 1 nhịp của chế độ auto: hệ thống tự chọn chế độ cho từng nhóm tranh chấp —
 * đơn không tranh thợ với ai -> Greedy top-k (tức thời); nhóm >= 2 đơn tranh cùng thợ -> Hungarian.
 */
export async function runAutoRound(cfg = null) {
  return transaction(async (db, after) => {
    await lock(db);
    cfg = cfg ?? (await getConfig(db));
    const { orders, dispatches } = await loadWaiting(db, 'auto');
    const res = { orders: orders.length, instant_orders: 0, instant_offers: 0, batch_groups: 0, batch: emptyBatch() };
    if (!orders.length) return res;

    const ranked = [];
    for (const o of orders) ranked.push(await rankForOrder(db, o, cfg));
    const groups = competitionGroups(ranked.map((r) => r.map((s) => s.id)));
    for (const group of groups) {
      if (group.length === 1) {
        const i = group[0];
        res.instant_orders += 1;
        res.instant_offers += await sendWave(db, after, orders[i], dispatches.get(Number(orders[i].id)), ranked[i], cfg);
      } else {
        res.batch_groups += 1;
        res.batch.orders += group.length;
        await assignHungarian(
          db,
          after,
          group.map((i) => orders[i]),
          group.map((i) => ranked[i]),
          dispatches,
          cfg,
          res.batch,
        );
      }
    }
    return res;
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Hết hạn, dọn dẹp, quá hạn, nhắc lịch
// ═════════════════════════════════════════════════════════════════════════

/** Offer quá thời gian trả lời -> expired; đơn được xét lại ngay ở nhịp này */
export async function expireOffers() {
  const rows = await transaction(async (db) => {
    const { rows: expired } = await sql(
      db,
      `UPDATE order_offers SET status = 'expired', responded_at = NOW()
       WHERE status = 'offered' AND expires_at <= NOW()
       RETURNING id, order_id, worker_id`,
    );
    if (expired.length) {
      await sql(db, 'UPDATE order_dispatches SET next_attempt_at = NOW() WHERE order_id = ANY($1::bigint[]) AND next_attempt_at > NOW()', [
        [...new Set(expired.map((r) => r.order_id))],
      ]);
      await refreshWorkerStats(db, expired.map((r) => r.worker_id));
    }
    return expired;
  });
  emitOfferClosed(rows);
  return rows.length;
}

/** Đơn đã rời trạng thái 'matching' (khách/admin huỷ, dev-tools nhận đơn...) -> đóng offer còn mở, bỏ khỏi hàng đợi */
export async function closeStaleOffers() {
  const rows = await transaction(async (db) => {
    const { rows: closed } = await sql(
      db,
      `UPDATE order_offers f SET status = 'expired', responded_at = NOW(), reason = 'closed'
       FROM orders o
       WHERE o.id = f.order_id AND f.status = 'offered' AND (o.status <> 'matching' OR o.worker_id IS NOT NULL)
       RETURNING f.id, f.order_id, f.worker_id`,
    );
    await sql(
      db,
      `DELETE FROM order_dispatches d USING orders o
       WHERE o.id = d.order_id AND (o.status <> 'matching' OR o.worker_id IS NOT NULL)`,
    );
    return closed;
  });
  emitOfferClosed(rows);
  return rows.length;
}

/** Hết thời gian chờ mà chưa có thợ nhận -> huỷ đơn, báo khách đặt lại */
export async function cancelOverdue() {
  return transaction(async (db, after) => {
    const { rows } = await sql(
      db,
      `SELECT o.id, o.code, o.customer_id FROM orders o JOIN order_dispatches d ON d.order_id = o.id
       WHERE o.status = 'matching' AND o.worker_id IS NULL AND d.deadline_at <= NOW()
       FOR UPDATE OF o SKIP LOCKED`,
    );
    const reason = 'Hệ thống: chưa tìm được thợ phù hợp trong thời gian chờ';
    for (const o of rows) {
      await sql(
        db,
        `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $2, updated_at = NOW() WHERE id = $1`,
        [o.id, reason],
      );
      await addHistory(db, o.id, 'matching', 'cancelled', null, reason);
      const { rows: closed } = await sql(
        db,
        `UPDATE order_offers SET status = 'expired', responded_at = NOW(), reason = 'closed'
         WHERE order_id = $1 AND status = 'offered' RETURNING id, order_id, worker_id`,
        [o.id],
      );
      await sql(db, 'DELETE FROM order_dispatches WHERE order_id = $1', [o.id]);
      after(async () => {
        emitOfferClosed(closed);
        emitOrderUpdated({ ...o, status: 'cancelled', worker_id: null });
        await notify(o.customer_id, {
          title: 'Chưa tìm được thợ',
          body: `Rất tiếc, đơn ${o.code} chưa có thợ phù hợp nhận. Bạn vui lòng đặt lại hoặc chọn giờ hẹn khác.`,
          type: 'order',
          data: { order_id: o.id },
        });
      });
    }
    return rows.length;
  });
}

/** Nhắc thợ trước giờ hẹn (mỗi đơn 1 lần) */
export async function sendScheduleReminders() {
  const { rows } = await sql(
    pool,
    `SELECT o.id, o.code, o.worker_id, o.scheduled_at, o.address_text FROM orders o
     WHERE o.status = 'accepted' AND o.scheduled_at > NOW()
       AND o.scheduled_at <= NOW() + make_interval(mins => $1)
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = o.worker_id AND n.type = 'order'
                         AND n.data->>'kind' = 'schedule_reminder' AND n.data->>'order_id' = o.id::text)`,
    [settings.scheduleReminderMinutes],
  );
  for (const o of rows) {
    await notify(o.worker_id, {
      title: 'Sắp đến giờ hẹn',
      body: `Đơn ${o.code} lúc ${vnClock(o.scheduled_at)} tại ${o.address_text}. Nhớ xuất phát sớm nhé!`,
      type: 'order',
      data: { order_id: o.id, kind: 'schedule_reminder' },
    });
    await refreshAvailability(pool, o.worker_id);
  }
  return rows.length;
}

// ═════════════════════════════════════════════════════════════════════════
// Thợ trả lời offer
// ═════════════════════════════════════════════════════════════════════════

/** Thợ nhận đơn. Trả về id đơn. Ai bấm trước (khoá dòng đơn) người đó được. */
export async function acceptOffer(workerId, offerId) {
  const outcome = await transaction(async (db, after) => {
    const { rows: found } = await sql(db, 'SELECT order_id FROM order_offers WHERE id = $1 AND worker_id = $2', [offerId, workerId]);
    if (!found[0]) throw new AppError(404, 'Không tìm thấy lời mời nhận đơn');

    // Khoá đơn trước rồi mới khoá offer (cùng thứ tự với luồng huỷ) để tránh deadlock
    const { rows: orows } = await sql(db, `${ORDER_SQL} WHERE o.id = $1 FOR UPDATE OF o`, [found[0].order_id]);
    const order = orows[0];
    const { rows: frows } = await sql(
      db,
      'SELECT id, status, expires_at <= NOW() AS is_expired FROM order_offers WHERE id = $1 FOR UPDATE',
      [offerId],
    );
    const offer = frows[0];

    if (offer.status !== 'offered') return { error: [409, 'Lời mời này đã hết hiệu lực'] };
    if (offer.is_expired) {
      await sql(db, "UPDATE order_offers SET status = 'expired', responded_at = NOW() WHERE id = $1", [offerId]);
      await refreshWorkerStats(db, [workerId]);
      return { error: [409, 'Đã hết thời gian nhận đơn'] };
    }
    if (order.status !== 'matching' || order.worker_id) {
      await sql(db, "UPDATE order_offers SET status = 'expired', responded_at = NOW(), reason = 'closed' WHERE id = $1", [offerId]);
      return { error: [409, 'Đơn đã có thợ khác nhận hoặc khách đã huỷ'] };
    }

    const { rows: wrows } = await sql(
      db,
      `SELECT w.verification_status, u.full_name FROM workers w JOIN users u ON u.id = w.user_id
       WHERE w.user_id = $1 FOR UPDATE OF w`,
      [workerId],
    );
    if (wrows[0]?.verification_status !== 'approved') throw new AppError(403, 'Hồ sơ chưa được duyệt');
    const scheduled = isFuture(order.scheduled_at);
    if (!scheduled && (await hasInflightInstantJob(db, workerId))) {
      throw new AppError(409, 'Bạn đang có việc chưa xong, hãy hoàn thành trước khi nhận đơn mới');
    }
    const when = scheduled ? new Date(order.scheduled_at) : new Date();
    if ((await conflictingWorkers(db, [workerId], when, order.id)).has(Number(workerId))) {
      throw new AppError(409, 'Bạn đã có lịch hẹn khác gần thời điểm này');
    }

    await sql(
      db,
      `UPDATE orders SET worker_id = $2, status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [order.id, workerId],
    );
    await addHistory(db, order.id, 'matching', 'accepted', workerId, 'Thợ nhận đơn');
    await sql(db, "UPDATE order_offers SET status = 'accepted', responded_at = NOW() WHERE id = $1", [offerId]);
    const { rows: closed } = await sql(
      db,
      `UPDATE order_offers SET status = 'expired', responded_at = NOW(), reason = 'closed'
       WHERE order_id = $1 AND id <> $2 AND status = 'offered' RETURNING id, order_id, worker_id`,
      [order.id, offerId],
    );
    await sql(db, 'DELETE FROM order_dispatches WHERE order_id = $1', [order.id]);
    await refreshAvailability(db, workerId);
    await refreshWorkerStats(db, [workerId]);

    after(async () => {
      emitOfferClosed(closed);
      emitOrderUpdated({ ...order, worker_id: workerId, status: 'accepted' });
      const whenText = order.scheduled_at ? ` (hẹn ${vnTime(order.scheduled_at)})` : '';
      await notify(order.customer_id, {
        title: 'Thợ đã nhận đơn',
        body: `${wrows[0].full_name} đã nhận đơn ${order.code}${whenText}`,
        type: 'order',
        data: { order_id: order.id },
      });
    });
    return { orderId: order.id };
  });
  if (outcome.error) throw new AppError(...outcome.error);
  return outcome.orderId;
}

/** Thợ bỏ qua đơn. Hết offer sống thì đơn được xét lại ngay (instant: gửi đợt mới luôn). */
export async function rejectOffer(workerId, offerId, reason = null) {
  const next = await transaction(async (db) => {
    const { rows } = await sql(
      db,
      'SELECT id, order_id, status FROM order_offers WHERE id = $1 AND worker_id = $2 FOR UPDATE',
      [offerId, workerId],
    );
    const offer = rows[0];
    if (!offer) throw new AppError(404, 'Không tìm thấy lời mời nhận đơn');
    if (offer.status !== 'offered') return null; // đã hết hạn / đơn đã có người nhận: coi như xong
    await sql(db, "UPDATE order_offers SET status = 'rejected', responded_at = NOW(), reason = $2 WHERE id = $1", [offerId, reason]);
    await refreshWorkerStats(db, [workerId]);
    if (await liveOfferExists(db, offer.order_id)) return null;
    const { rows: d } = await sql(
      db,
      'UPDATE order_dispatches SET next_attempt_at = NOW() WHERE order_id = $1 RETURNING mode',
      [offer.order_id],
    );
    return d[0] ? { orderId: offer.order_id, mode: d[0].mode } : null;
  });
  if (next?.mode === 'instant') await runInstantWave(next.orderId);
}

/** Thợ tắt nhận đơn: offer đang chờ của thợ coi như đóng để đơn đi tiếp (không tính là bỏ lỡ) */
export async function withdrawWorkerOffers(db, after, workerId) {
  const { rows } = await sql(
    db,
    `UPDATE order_offers SET status = 'expired', responded_at = NOW(), reason = 'offline'
     WHERE worker_id = $1 AND status = 'offered' RETURNING id, order_id, worker_id`,
    [workerId],
  );
  if (rows.length) {
    await sql(db, 'UPDATE order_dispatches SET next_attempt_at = NOW() WHERE order_id = ANY($1::bigint[])', [
      rows.map((r) => r.order_id),
    ]);
    after(() => emitOfferClosed(rows));
  }
}

/**
 * Thợ huỷ khi chưa tới nơi: trả đơn về hàng đợi để tìm thợ khác (không mời lại thợ này).
 * Trả về chế độ của hàng đợi để nơi gọi chạy đợt mới ngay sau khi COMMIT (nếu instant).
 */
export async function requeueAfterWorkerCancel(db, after, order, workerId, reason) {
  await sql(
    db,
    `UPDATE order_offers SET status = 'cancelled', responded_at = NOW(), reason = $3
     WHERE order_id = $1 AND worker_id = $2`,
    [order.id, workerId, reason],
  );
  await sql(
    db,
    `UPDATE orders SET worker_id = NULL, status = 'matching', accepted_at = NULL, updated_at = NOW() WHERE id = $1`,
    [order.id],
  );
  await addHistory(db, order.id, order.status, 'matching', workerId, `Thợ huỷ nhận đơn: ${reason}`);
  const cfg = await getConfig(db);
  const deadline = deadlineOf(order);
  const { rows } = await sql(
    db,
    `INSERT INTO order_dispatches (order_id, mode, deadline_at) VALUES ($1, $2, $3)
     ON CONFLICT (order_id) DO UPDATE SET next_attempt_at = NOW(),
       deadline_at = GREATEST(order_dispatches.deadline_at, EXCLUDED.deadline_at)
     RETURNING mode`,
    [order.id, cfg.mode, deadline],
  );
  await refreshWorkerStats(db, [workerId]);
  after(async () => {
    emitOrderUpdated({ ...order, status: 'matching', worker_id: null });
    emitToUser(workerId, 'order:updated', { order_id: Number(order.id), status: 'matching' });
    await notify(order.customer_id, {
      title: 'Thợ đã huỷ nhận đơn',
      body: `Đơn ${order.code}: thợ không thể đến (${reason}). Hệ thống đang tìm thợ khác cho bạn.`,
      type: 'order',
      data: { order_id: order.id },
    });
  });
  return rows[0].mode;
}
