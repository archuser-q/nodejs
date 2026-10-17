/**
 * ĐIỂM NỐI VỚI MODULE GHÉP CẶP (thuộc thành viên phụ trách thuật toán matching).
 *
 * App khách chỉ cần 2 hàm: dispatchOffers(orderId) gọi sau khi tạo đơn, refreshOffers(orderId)
 * gọi khi khách xem đơn đang tìm thợ. Bản dưới đây là cài đặt TẠM để app khách chạy được:
 * dùng findCandidates + rankCandidates có sẵn, ghi đề xuất vào order_offers.
 * Bạn làm matching có thể thay toàn bộ nội dung file này bằng logic của mình, giữ nguyên tên 2 hàm.
 * Đơn chế độ "batch" để nguyên trạng thái matching cho job ghép theo lô xử lý.
 */
import { q, sql, pool } from '../../config/db.js';
import { findCandidates } from '../candidate.js';
import { rankCandidates } from '../scoring.js';

// Số thợ nhận đề xuất mỗi lượt
const OFFER_BATCH = 5;

// Dùng khi admin chưa bật cấu hình nào
const DEFAULT_CONFIG = {
  id: null,
  w_distance: 0.35, w_trust: 0.3, w_skill: 0.15, w_acceptance: 0.1, w_workload: 0.1,
  max_radius_km: 10, offer_timeout_seconds: 30, batch_window_seconds: 10,
};

export const getConfig = async (db, id = null) => {
  const { rows } = await sql(
    db,
    `SELECT id, w_distance, w_trust, w_skill, w_acceptance, w_workload,
            max_radius_km, offer_timeout_seconds, batch_window_seconds
     FROM matching_configs WHERE ${id ? 'id = $1' : 'is_active'} LIMIT 1`,
    id ? [id] : [],
  );
  return rows[0] ?? DEFAULT_CONFIG;
};

export const dispatchOffers = async (orderId) => {
  const { rows } = await q(
    `SELECT o.id, o.code, o.status, o.matching_mode, o.matching_config_id,
            ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lng,
            s.category_id, s.name AS service_name, o.address_text
     FROM orders o JOIN services s ON s.id = o.service_id
     WHERE o.id = $1`,
    [orderId],
  );
  const order = rows[0];
  if (!order || order.status !== 'matching' || order.matching_mode !== 'instant') return { offered: 0 };

  const config = await getConfig(pool, order.matching_config_id);
  const candidates = await findCandidates({
    lat: order.lat, lng: order.lng, categoryId: order.category_id, radiusKm: config.max_radius_km,
  });

  const { rows: prev } = await q('SELECT worker_id FROM order_offers WHERE order_id = $1', [orderId]);
  const offeredBefore = new Set(prev.map((r) => String(r.worker_id)));
  const ranked = rankCandidates(candidates.filter((c) => !offeredBefore.has(String(c.id))), config)
    .slice(0, OFFER_BATCH);

  const offered = [];
  for (const [i, c] of ranked.entries()) {
    const { rows: ins } = await q(
      `INSERT INTO order_offers (order_id, worker_id, mode, score, distance_km, rank_position, expires_at)
       VALUES ($1, $2, 'instant', $3, $4, $5, NOW() + make_interval(secs => $6))
       ON CONFLICT (order_id, worker_id) DO NOTHING
       RETURNING id, worker_id, expires_at`,
      [orderId, c.id, c.score.toFixed(5), (c.distance_m / 1000).toFixed(3), prev.length + i + 1, config.offer_timeout_seconds],
    );
    if (ins[0]) offered.push({ ...ins[0], score: c.score, distance_km: c.distance_m / 1000 });
  }

  // Báo cho thợ có đơn mới (push / socket) là việc của module ghép cặp + App Thợ
  return { offered: offered.length };
};

/**
 * Gọi khi khách xem đơn đang tìm thợ: đề xuất cũ hết hạn mà chưa ai nhận
 * thì đánh dấu expired và gửi tiếp cho nhóm thợ kế tiếp.
 */
export const refreshOffers = async (orderId) => {
  await q(
    `UPDATE order_offers SET status = 'expired', responded_at = NOW()
     WHERE order_id = $1 AND status = 'offered' AND expires_at < NOW()`,
    [orderId],
  );
  const { rows } = await q(
    `SELECT COUNT(*) FILTER (WHERE status = 'offered')::int AS open FROM order_offers WHERE order_id = $1`,
    [orderId],
  );
  if (rows[0].open === 0) await dispatchOffers(orderId);
};
