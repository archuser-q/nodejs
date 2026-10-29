/**
 * App thợ: ví, hoa hồng, thu nhập theo ngày/tuần/tháng, rút tiền, đánh giá & hiệu suất.  [Thành viên B]
 *
 * Mô hình ví: nền tảng KHÔNG nhận tiền mặt, mọi đơn khách trả qua cổng thanh toán (MoMo / VNPay):
 *  - nền tảng giữ tiền, cộng vào ví thợ phần thực nhận (tổng - hoa hồng COMMISSION_RATE);
 *  - thợ rút tiền về tài khoản ngân hàng (demo: duyệt ngay; tắt WITHDRAWAL_AUTO_APPROVE thì admin duyệt).
 * Số dư = workers.wallet_balance (không âm); mỗi biến động là 1 dòng worker_transactions (kèm balance_after).
 * Dữ liệu cũ có đơn tiền mặt (type 'commission' trừ ví) vẫn hiển thị đúng trong lịch sử.
 */
import crypto from 'crypto';
import { pool, q, sql } from '../../config/db.js';
import { settings } from '../../config/settings.js';
import { AppError } from '../../utils/AppError.js';
import { transaction } from '../../utils/tx.js';
import { givenName, money } from '../../utils/vn.js';
import { notify } from '../shared/notify.service.js';
import { commissionOf } from './state.js';
import { explainTrust } from '../trust/trust.service.js';
import { DAY, vnDayOfMonth, vnDayStart, vnKey, vnMonthStart, vnWeekStart, vnWeekday } from './time.js';

const PAYMENT_LABEL = { momo: 'MoMo', vnpay: 'VNPay' };
const WEEKDAY_SHORT = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const PERIOD_LABEL = { today: 'Hôm nay', week: 'Tuần này', month: 'Tháng này' };
const PERFORMANCE_DAYS = 30;

// ═════════════════════════════════════════════════════════════════════════
// Bút toán ví
// ═════════════════════════════════════════════════════════════════════════

/** Ghi 1 biến động ví (khoá dòng thợ để số dư không lệch khi 2 giao dịch cùng lúc). Đơn đã ghi loại này rồi thì bỏ qua. */
export async function addWalletTxn(db, { workerId, type, amount, orderId = null, withdrawalId = null, note, at = null }) {
  if (orderId) {
    const { rows } = await sql(db, 'SELECT 1 FROM worker_transactions WHERE order_id = $1 AND type = $2', [orderId, type]);
    if (rows.length) return null;
  }
  const { rows: w } = await sql(
    db,
    'UPDATE workers SET wallet_balance = wallet_balance + $2, updated_at = NOW() WHERE user_id = $1 RETURNING wallet_balance',
    [workerId, amount],
  );
  if (!w[0]) return null;
  const { rows } = await sql(
    db,
    `INSERT INTO worker_transactions (worker_id, order_id, withdrawal_id, type, amount, balance_after, note, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
     RETURNING id, type, amount, balance_after, note, order_id, created_at`,
    [workerId, orderId, withdrawalId, type, amount, w[0].wallet_balance, note, at],
  );
  return rows[0];
}

/**
 * Gọi khi thanh toán của đơn thành công (nối vào settlePayment của app khách, cùng transaction):
 * chốt hoa hồng của đơn + ghi bút toán ví thợ. Gọi lặp lại không sao (idempotent).
 */
export async function recordPaidOrder(db, orderId) {
  const { rows } = await sql(
    db,
    `SELECT o.id, o.code, o.worker_id, p.method, p.amount, p.paid_at
     FROM orders o JOIN payments p ON p.order_id = o.id AND p.status = 'success'
     WHERE o.id = $1 ORDER BY p.paid_at DESC NULLS LAST LIMIT 1`,
    [orderId],
  );
  const r = rows[0];
  if (!r?.worker_id) return null;
  const gross = Number(r.amount);
  const commission = commissionOf(gross);
  await sql(db, 'UPDATE orders SET commission_amount = COALESCE(commission_amount, $2), updated_at = NOW() WHERE id = $1', [
    orderId,
    commission,
  ]);
  const rate = Math.round(settings.commissionRate * 100);
  return addWalletTxn(db, {
    workerId: r.worker_id,
    orderId,
    type: 'earning',
    amount: gross - commission,
    note: `Thu nhập đơn ${r.code} (khách trả qua ${PAYMENT_LABEL[r.method] ?? r.method}, đã trừ phí ${rate}%)`,
    at: r.paid_at,
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Thu nhập
// ═════════════════════════════════════════════════════════════════════════

/** Các đơn đã thanh toán của thợ trong [start, end): gross = tiền khách trả, net = gross - hoa hồng */
async function earningRows(workerId, start, end) {
  const { rows } = await q(
    `SELECT o.id AS order_id, o.code, s.name AS service_name, p.amount AS gross,
            COALESCE(o.commission_amount, ROUND(p.amount * $4)) AS commission, p.method, p.paid_at
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN services s ON s.id = o.service_id
     WHERE o.worker_id = $1 AND p.status = 'success' AND p.paid_at >= $2 AND p.paid_at < $3
     ORDER BY p.paid_at`,
    [workerId, new Date(start), new Date(end), settings.commissionRate],
  );
  return rows.map((r) => ({ ...r, net: r.gross - r.commission, t: new Date(r.paid_at).getTime() }));
}

export async function incomeBetween(workerId, start, end) {
  const rows = await earningRows(workerId, start, end);
  return {
    completed: rows.length,
    gross_income: rows.reduce((s, r) => s + r.gross, 0),
    net_income: rows.reduce((s, r) => s + r.net, 0),
  };
}

function windows(period, now) {
  const today = vnDayStart(now);
  let start;
  let end;
  let prevStart;
  if (period === 'today') {
    start = today;
    end = today + DAY;
    prevStart = start - DAY;
  } else if (period === 'week') {
    start = vnWeekStart(now);
    end = start + 7 * DAY;
    prevStart = start - 7 * DAY;
  } else {
    start = vnMonthStart(now);
    end = vnMonthStart(now, 1);
    prevStart = vnMonthStart(now, -1);
  }
  // So sánh "cùng kỳ": kỳ trước tính tới đúng thời điểm tương ứng (tuần này mới tới Thứ 3 thì so với T2–T3 tuần trước)
  const elapsed = Math.min(now, end) - start;
  return { start, end, prev: [prevStart, Math.min(start, prevStart + elapsed)] };
}

const percentChange = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

export async function earningsSummary(workerId, period) {
  const now = Date.now();
  const { start, end, prev } = windows(period, now);
  const rows = await earningRows(workerId, start, end);
  const prevRows = await earningRows(workerId, prev[0], prev[1]);
  const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
  const net = sum(rows, 'net');

  // Biểu đồ: Hôm nay -> 7 ngày gần nhất; Tuần -> T2..CN; Tháng -> từng ngày trong tháng
  let days;
  if (period === 'today') days = Array.from({ length: 7 }, (_, i) => vnDayStart(now) - (6 - i) * DAY);
  else days = Array.from({ length: Math.round((end - start) / DAY) }, (_, i) => start + i * DAY);
  const chartRows = await earningRows(workerId, days[0], days[days.length - 1] + DAY);
  const buckets = new Map(days.map((d) => [vnKey(d), { net: 0, orders: 0 }]));
  for (const r of chartRows) {
    const b = buckets.get(vnKey(r.t));
    if (b) {
      b.net += r.net;
      b.orders += 1;
    }
  }
  const todayKey = vnKey(now);
  const chart = days.map((d) => {
    const key = vnKey(d);
    const label = period === 'month' ? String(vnDayOfMonth(d)) : key === todayKey ? 'Nay' : WEEKDAY_SHORT[vnWeekday(d)];
    return { key, label, ...buckets.get(key) };
  });

  const { rows: unpaid } = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(final_price, estimated_price + extra_amount)), 0) AS amount
     FROM orders o WHERE o.worker_id = $1 AND o.status = 'completed'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'success')`,
    [workerId],
  );
  return {
    period,
    label: PERIOD_LABEL[period],
    start: new Date(start),
    end: new Date(end),
    totals: {
      orders: rows.length,
      gross: sum(rows, 'gross'),
      commission: sum(rows, 'commission'),
      net,
      avg_net_per_order: rows.length ? Math.round(net / rows.length) : 0,
    },
    previous_net: sum(prevRows, 'net'),
    change_percent: percentChange(net, sum(prevRows, 'net')),
    chart,
    unpaid_orders: unpaid[0].n,
    unpaid_amount: unpaid[0].amount,
  };
}

export async function earningsHistory(workerId, { pageSize, offset }) {
  const { rows } = await q(
    `SELECT o.id AS order_id, o.code, s.name AS service_name, p.amount AS gross_amount,
            COALESCE(o.commission_amount, ROUND(p.amount * $4)) AS commission_amount,
            p.method AS payment_method, p.paid_at AS created_at, COUNT(*) OVER()::int AS total
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN services s ON s.id = o.service_id
     WHERE o.worker_id = $1 AND p.status = 'success'
     ORDER BY p.paid_at DESC, o.id DESC
     LIMIT $2 OFFSET $3`,
    [workerId, pageSize, offset, settings.commissionRate],
  );
  return {
    items: rows.map(({ total, ...r }) => ({ ...r, net_amount: r.gross_amount - r.commission_amount })),
    total: rows[0]?.total ?? 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Ví & rút tiền
// ═════════════════════════════════════════════════════════════════════════

const TX_FIELDS = 'id, type, amount, balance_after, note, order_id, withdrawal_id, created_at';
const WD_FIELDS = `id, amount, bank_name, account_number, account_holder, status, transaction_code, note,
                   created_at, processed_at`;

export async function getBank(db, workerId) {
  const { rows } = await sql(
    db,
    'SELECT bank_name, account_number, account_holder, updated_at FROM worker_bank_accounts WHERE worker_id = $1',
    [workerId],
  );
  return rows[0] ?? null;
}

export async function wallet(workerId) {
  const [{ rows: w }, { rows: pending }, { rows: recent }, bank] = await Promise.all([
    q('SELECT wallet_balance FROM workers WHERE user_id = $1', [workerId]),
    q("SELECT COALESCE(SUM(amount), 0) AS s FROM worker_withdrawals WHERE worker_id = $1 AND status = 'pending'", [workerId]),
    q(`SELECT ${TX_FIELDS} FROM worker_transactions WHERE worker_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10`, [workerId]),
    getBank(pool, workerId),
  ]);
  const balance = w[0]?.wallet_balance ?? 0;
  return {
    balance,
    available_for_withdrawal: Math.max(0, balance),
    min_withdrawal: settings.minWithdrawal,
    pending_withdrawal: pending[0].s,
    bank_account: bank,
    recent,
  };
}

export async function transactions(workerId, { pageSize, offset }) {
  const { rows } = await q(
    `SELECT ${TX_FIELDS}, COUNT(*) OVER()::int AS total FROM worker_transactions
     WHERE worker_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [workerId, pageSize, offset],
  );
  return { items: rows.map(({ total, ...t }) => t), total: rows[0]?.total ?? 0 };
}

export async function createWithdrawal(workerId, amount) {
  return transaction(async (db, after) => {
    // Khoá dòng thợ để 2 yêu cầu rút cùng lúc không vượt số dư
    const { rows: w } = await sql(db, 'SELECT wallet_balance FROM workers WHERE user_id = $1 FOR UPDATE', [workerId]);
    const bank = await getBank(db, workerId);
    if (!bank) throw new AppError(400, 'Hãy liên kết tài khoản ngân hàng trước khi rút tiền');
    if (amount < settings.minWithdrawal) throw new AppError(400, `Số tiền rút tối thiểu ${money(settings.minWithdrawal)}`);
    const balance = w[0]?.wallet_balance ?? 0;
    if (amount > balance) throw new AppError(400, `Số dư khả dụng chỉ còn ${money(Math.max(0, balance))}`);

    const auto = settings.withdrawalAutoApprove;
    const { rows } = await sql(
      db,
      `INSERT INTO worker_withdrawals (worker_id, amount, bank_name, account_number, account_holder,
                                       status, transaction_code, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() END)
       RETURNING ${WD_FIELDS}`,
      [
        workerId,
        amount,
        bank.bank_name,
        bank.account_number,
        bank.account_holder,
        auto ? 'completed' : 'pending',
        auto ? `SANDBOX-WD-${crypto.randomBytes(5).toString('hex').toUpperCase()}` : null,
        auto,
      ],
    );
    const wd = rows[0];
    const tail = bank.account_number.slice(-4);
    await addWalletTxn(db, {
      workerId,
      type: 'withdraw',
      amount: -amount,
      withdrawalId: wd.id,
      note: `Rút tiền về ${bank.bank_name} ****${tail}`,
    });
    if (auto) {
      after(() =>
        notify(workerId, {
          title: 'Rút tiền thành công',
          body: `${money(amount)} đã chuyển về ${bank.bank_name} ****${tail}`,
          type: 'payment',
          data: { withdrawal_id: wd.id },
        }),
      );
    }
    return wd;
  });
}

export async function listWithdrawals(workerId, { pageSize, offset }) {
  const { rows } = await q(
    `SELECT ${WD_FIELDS}, COUNT(*) OVER()::int AS total FROM worker_withdrawals
     WHERE worker_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [workerId, pageSize, offset],
  );
  return { items: rows.map(({ total, ...w }) => w), total: rows[0]?.total ?? 0 };
}

/** Admin duyệt / từ chối lệnh rút (khi tắt WITHDRAWAL_AUTO_APPROVE). Từ chối thì hoàn tiền vào ví. */
export async function processWithdrawal(id, adminId, approve, note = null) {
  return transaction(async (db, after) => {
    const { rows } = await sql(db, `SELECT ${WD_FIELDS}, worker_id FROM worker_withdrawals WHERE id = $1 FOR UPDATE`, [id]);
    const wd = rows[0];
    if (!wd) throw new AppError(404, 'Không tìm thấy lệnh rút tiền');
    if (wd.status !== 'pending') throw new AppError(400, 'Lệnh rút đã được xử lý');
    const { rows: upd } = await sql(
      db,
      `UPDATE worker_withdrawals SET status = $2::text, note = $3, processed_by = $4, processed_at = NOW(),
              transaction_code = CASE WHEN $2::text = 'completed' THEN $5 ELSE NULL END
       WHERE id = $1 RETURNING ${WD_FIELDS}`,
      [id, approve ? 'completed' : 'rejected', note, adminId, `WD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`],
    );
    if (!approve) {
      await addWalletTxn(db, { workerId: wd.worker_id, type: 'refund', amount: wd.amount, withdrawalId: wd.id, note: `Hoàn tiền lệnh rút #${wd.id}${note ? `: ${note}` : ''}` });
    }
    after(() =>
      notify(wd.worker_id, {
        title: approve ? 'Rút tiền thành công' : 'Lệnh rút tiền bị từ chối',
        body: approve ? `${money(wd.amount)} đã chuyển về ${wd.bank_name}` : `${money(wd.amount)} đã được hoàn vào ví${note ? `. Lý do: ${note}` : ''}`,
        type: 'payment',
        data: { withdrawal_id: wd.id },
      }),
    );
    return upd[0];
  });
}

export async function listAllWithdrawals({ status, pageSize, offset }) {
  const { rows } = await q(
    `SELECT wd.id, wd.worker_id, u.full_name AS worker_name, u.phone AS worker_phone, wd.amount, wd.bank_name,
            wd.account_number, wd.account_holder, wd.status, wd.transaction_code, wd.note, wd.created_at, wd.processed_at,
            COUNT(*) OVER()::int AS total
     FROM worker_withdrawals wd JOIN users u ON u.id = wd.worker_id
     WHERE ($1::text IS NULL OR wd.status = $1)
     ORDER BY (wd.status = 'pending') DESC, wd.created_at DESC LIMIT $2 OFFSET $3`,
    [status ?? null, pageSize, offset],
  );
  return { items: rows.map(({ total, ...w }) => w), total: rows[0]?.total ?? 0 };
}

// ═════════════════════════════════════════════════════════════════════════
// Đánh giá & hiệu suất
// ═════════════════════════════════════════════════════════════════════════

export async function reviews(workerId, rating, { pageSize, offset }) {
  const [{ rows: dist }, { rows }] = await Promise.all([
    q('SELECT rating, COUNT(*)::int AS n FROM reviews WHERE worker_id = $1 GROUP BY rating', [workerId]),
    q(
      `SELECT r.id, r.order_id, o.code, r.rating, r.comment, r.image_urls, u.full_name AS customer_name,
              s.name AS service_name, r.created_at, COUNT(*) OVER()::int AS total
       FROM reviews r
       JOIN users u ON u.id = r.customer_id
       JOIN orders o ON o.id = r.order_id
       JOIN services s ON s.id = o.service_id
       WHERE r.worker_id = $1 AND ($2::int IS NULL OR r.rating = $2)
       ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [workerId, rating ?? null, pageSize, offset],
    ),
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const d of dist) distribution[d.rating] = d.n;
  const count = Object.values(distribution).reduce((a, b) => a + b, 0);
  const avg = count ? Math.round((Object.entries(distribution).reduce((s, [k, v]) => s + k * v, 0) / count) * 100) / 100 : null;
  return {
    items: rows.map(({ total, customer_name, ...r }) => ({ ...r, customer_name: givenName(customer_name) })),
    total: rows[0]?.total ?? 0,
    summary: { rating_avg: avg, rating_count: count, distribution },
  };
}

export async function performance(workerId) {
  const [{ rows: offers }, { rows: jobs }, { rows: w }, { rows: totalNet }] = await Promise.all([
    q(
      `SELECT COUNT(*)::int AS received,
              COUNT(*) FILTER (WHERE status IN ('accepted', 'cancelled'))::int AS accepted,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE status = 'expired' AND reason IS NULL AND responded_at >= expires_at)::int AS expired,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM order_offers WHERE worker_id = $1 AND offered_at >= NOW() - make_interval(days => $2)`,
      [workerId, PERFORMANCE_DAYS],
    ),
    q(
      `SELECT COUNT(*)::int AS completed FROM orders
       WHERE worker_id = $1 AND status = 'completed' AND completed_at >= NOW() - make_interval(days => $2)`,
      [workerId, PERFORMANCE_DAYS],
    ),
    q(
      `SELECT rating_avg, rating_count, trust_score, total_jobs, acceptance_rate, cancel_rate
       FROM workers WHERE user_id = $1`,
      [workerId],
    ),
    q(
      `SELECT COALESCE(SUM(p.amount - COALESCE(o.commission_amount, ROUND(p.amount * $2))), 0) AS net
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.worker_id = $1 AND p.status = 'success'`,
      [workerId, settings.commissionRate],
    ),
  ]);
  const o = offers[0];
  const answered = o.accepted + o.rejected + o.expired;
  const completed = jobs[0].completed;
  const p = w[0];
  return {
    period_days: PERFORMANCE_DAYS,
    offers_received: o.received,
    offers_accepted: o.accepted,
    offers_rejected: o.rejected,
    offers_expired: o.expired,
    acceptance_rate: answered ? Math.round((o.accepted / answered) * 10000) / 10000 : null,
    matching_acceptance_rate: p.acceptance_rate, // giá trị bộ ghép cặp đang dùng (đã làm mượt)
    jobs_completed: completed,
    jobs_cancelled_by_worker: o.cancelled,
    completion_rate: completed + o.cancelled ? Math.round((completed / (completed + o.cancelled)) * 10000) / 10000 : null,
    rating_avg: p.rating_count ? p.rating_avg : null,
    rating_count: p.rating_count,
    trust_score: p.trust_score,
    // Giải thích điểm tin cậy cho thợ: 3 thành phần + trọng số (algorithms/trust.js)
    trust: await explainTrust(pool, workerId),
    total_completed: p.total_jobs,
    total_net: totalNet[0].net,
  };
}
