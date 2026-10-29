/**
 * Trạng thái làm việc của thợ (dùng chung cho bộ điều phối và API app thợ).  [Thành viên B]
 *
 * Bảng workers của nhóm có 2 cờ: is_online (thợ tự bật/tắt nhận đơn) và is_busy (đang có việc).
 * App thợ hiển thị 3 trạng thái: offline (!is_online) · busy (is_online && is_busy) · online.
 */
import { sql } from '../../config/db.js';
import { settings } from '../../config/settings.js';

/** Đơn thợ đang giữ (đã nhận, chưa xong) */
export const OPEN_JOB_STATUSES = ['accepted', 'on_the_way', 'arrived', 'in_progress'];
/** Đơn thợ đang thực hiện thật sự (đã xuất phát) */
export const INFLIGHT_STATUSES = ['on_the_way', 'arrived', 'in_progress'];

const BUSY_EXPR = `EXISTS (
  SELECT 1 FROM orders o
  WHERE o.worker_id = w.user_id
    AND (o.status IN ('on_the_way', 'arrived', 'in_progress')
         OR (o.status = 'accepted'
             AND (o.scheduled_at IS NULL OR o.scheduled_at <= NOW() + make_interval(mins => ${settings.busyBeforeScheduleMinutes}))))
)`;

export const availabilityOf = (w) => (!w.is_online ? 'offline' : w.is_busy ? 'busy' : 'online');

/**
 * Tính lại is_busy sau khi nhận / hoàn thành / huỷ đơn:
 * bận = có đơn đang đi/sửa, hoặc đơn đặt ngay đã nhận, hoặc đơn hẹn trong vòng 60 phút tới.
 */
export const refreshAvailability = async (db, workerId) => {
  if (!workerId) return;
  await sql(db, `UPDATE workers w SET is_busy = ${BUSY_EXPR}, updated_at = NOW() WHERE w.user_id = $1`, [workerId]);
};

/** Đồng bộ is_busy cho mọi thợ (bộ điều phối gọi định kỳ: lịch hẹn tới gần thì tự chuyển sang bận) */
export const syncBusyFlags = async (db) => {
  const { rowCount } = await sql(
    db,
    `UPDATE workers w SET is_busy = NOT w.is_busy, updated_at = NOW()
     WHERE w.user_id IN (
             SELECT user_id FROM workers WHERE is_busy
             UNION
             SELECT worker_id FROM orders WHERE worker_id IS NOT NULL AND status = ANY($1::order_status[]))
       AND w.is_busy <> ${BUSY_EXPR}`,
    [OPEN_JOB_STATUSES],
  );
  return rowCount;
};

/** Thợ đang có việc đặt ngay / đang đi làm (không nhận thêm đơn đặt ngay) */
export const hasInflightInstantJob = async (db, workerId, excludeOrderId = null) => {
  const { rows } = await sql(
    db,
    `SELECT 1 FROM orders
     WHERE worker_id = $1 AND ($2::bigint IS NULL OR id <> $2)
       AND (status IN ('on_the_way', 'arrived', 'in_progress') OR (status = 'accepted' AND scheduled_at IS NULL))
     LIMIT 1`,
    [workerId, excludeOrderId],
  );
  return rows.length > 0;
};

/** Các thợ (trong workerIds) đã có việc khác trong khoảng ± scheduleConflictMinutes quanh mốc `when` */
export const conflictingWorkers = async (db, workerIds, when, excludeOrderId = null) => {
  if (!workerIds.length) return new Set();
  const { rows } = await sql(
    db,
    `SELECT DISTINCT worker_id FROM orders
     WHERE worker_id = ANY($1::bigint[]) AND status = ANY($2::order_status[])
       AND ($4::bigint IS NULL OR id <> $4)
       AND COALESCE(scheduled_at, accepted_at, created_at)
           BETWEEN $3::timestamptz - make_interval(mins => $5) AND $3::timestamptz + make_interval(mins => $5)`,
    [workerIds, OPEN_JOB_STATUSES, when, excludeOrderId, settings.scheduleConflictMinutes],
  );
  return new Set(rows.map((r) => Number(r.worker_id)));
};

export const commissionOf = (gross) => Math.round(Number(gross) * settings.commissionRate);
