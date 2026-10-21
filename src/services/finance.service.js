import { query } from '../config/db.js';

/**
 * Tài chính cho web quản trị (chỉ đọc).
 *  - Ví thợ: mọi biến động trong worker_transactions (thu nhập, hoa hồng, nạp, rút, hoàn tiền, điều chỉnh).
 *    Ghi ví do app thợ / settlePayment() của B lo; trang admin chỉ xem và đối soát.
 *  - Thanh toán của khách: bảng payments (tiền mặt / MoMo / VNPay) — khách không có ví, trả theo từng đơn.
 * Lọc ngày theo giờ Việt Nam.
 */
const VN_DAY = (p) => `(${p}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

export const TXN_TYPES = ['earning', 'commission', 'topup', 'withdraw', 'refund', 'adjustment'];

const txnFilter = ({ workerId, type, from, to, search }) => {
  const params = [];
  const conditions = ['TRUE'];
  if (workerId) {
    params.push(workerId);
    conditions.push(`t.worker_id = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`t.type = $${params.length}::wallet_txn_type`);
  }
  if (from) {
    params.push(from);
    conditions.push(`t.created_at >= ${VN_DAY(`$${params.length}`)}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`t.created_at < ${VN_DAY(`$${params.length}`)} + INTERVAL '1 day'`);
  }
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(u.full_name ILIKE ${p} OR u.phone ILIKE ${p} OR o.code ILIKE ${p})`);
  }
  return { params, where: conditions.join(' AND ') };
};

export const listTransactions = async ({ page, pageSize, ...filter }) => {
  const { params, where } = txnFilter(filter);
  const from = `FROM worker_transactions t
       JOIN users u ON u.id = t.worker_id
       LEFT JOIN orders o ON o.id = t.order_id`;
  const [list, sums] = await Promise.all([
    query(
      `SELECT t.id, t.worker_id, u.full_name AS worker_name, u.phone AS worker_phone, t.type,
              t.amount::float8 AS amount, t.balance_after::float8 AS balance_after, t.note,
              t.order_id, o.code AS order_code, t.withdrawal_id, t.created_at,
              COUNT(*) OVER()::int AS total
       ${from}
       WHERE ${where}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
    query(
      `SELECT t.type, COUNT(*)::int AS count, COALESCE(SUM(t.amount), 0)::float8 AS amount
       ${from}
       WHERE ${where}
       GROUP BY t.type`,
      params,
    ),
  ]);
  return {
    items: list.rows.map(({ total, ...t }) => t),
    total: list.rows[0]?.total ?? 0,
    summary: sums.rows,
  };
};

export const PAYMENT_METHODS = ['cash', 'momo', 'vnpay'];
export const PAYMENT_STATUSES = ['pending', 'success', 'failed', 'refunded'];

export const listPayments = async ({ method, status, from, to, search, page, pageSize }) => {
  const params = [];
  const conditions = ['TRUE'];
  if (method) {
    params.push(method);
    conditions.push(`p.method = $${params.length}::payment_method`);
  }
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}::payment_status`);
  }
  if (from) {
    params.push(from);
    conditions.push(`p.created_at >= ${VN_DAY(`$${params.length}`)}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`p.created_at < ${VN_DAY(`$${params.length}`)} + INTERVAL '1 day'`);
  }
  if (search) {
    params.push(`%${search}%`);
    const s = `$${params.length}`;
    conditions.push(`(o.code ILIKE ${s} OR c.full_name ILIKE ${s} OR c.phone ILIKE ${s} OR w.full_name ILIKE ${s} OR p.provider_txn_id ILIKE ${s})`);
  }
  const where = conditions.join(' AND ');
  const from_ = `FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN users c ON c.id = o.customer_id
       LEFT JOIN users w ON w.id = o.worker_id`;

  const [list, sums] = await Promise.all([
    query(
      `SELECT p.id, p.method, p.status, p.amount::float8 AS amount, p.provider_txn_id, p.paid_at, p.created_at,
              o.id AS order_id, o.code AS order_code, o.commission_amount::float8 AS commission_amount,
              c.full_name AS customer_name, c.phone AS customer_phone, w.full_name AS worker_name,
              COUNT(*) OVER()::int AS total
       ${from_}
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
    query(
      `SELECT p.method, p.status, COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0)::float8 AS amount
       ${from_}
       WHERE ${where}
       GROUP BY p.method, p.status`,
      params,
    ),
  ]);
  return {
    items: list.rows.map(({ total, ...p }) => p),
    total: list.rows[0]?.total ?? 0,
    summary: sums.rows,
  };
};
