/**
 * [Thành viên B] API admin cho bộ điều phối ghép cặp + duyệt rút tiền của thợ.
 *   GET  /api/admin/dispatch/status          trạng thái vòng điều phối, hàng đợi, cấu hình đang bật
 *   PUT  /api/admin/dispatch/mode            { mode: instant|batch|auto, max_offers? } cho cấu hình đang bật
 *   GET  /api/admin/withdrawals              ?status=pending|completed|rejected&page&pageSize
 *   POST /api/admin/withdrawals/:id/approve  | /reject { note }
 */
import { Router } from 'express';
import { q } from '../../config/db.js';
import { dispatcher } from '../../services/matching/dispatcher.js';
import { getConfig, MODES } from '../../services/matching/config.js';
import { listAllWithdrawals, processWithdrawal } from '../../services/worker/finance.service.js';
import { AppError } from '../../utils/AppError.js';
import * as v from '../../utils/validate.js';

export const dispatchRoutes = Router();

dispatchRoutes.get('/status', async (req, res) => {
  const [cfg, { rows: queue }, { rows: offers }] = await Promise.all([
    getConfig(),
    q(
      `SELECT d.mode, COUNT(*)::int AS orders, MIN(d.created_at) AS oldest
       FROM order_dispatches d JOIN orders o ON o.id = d.order_id
       WHERE o.status = 'matching' GROUP BY d.mode`,
    ),
    q("SELECT COUNT(*)::int AS live FROM order_offers WHERE status = 'offered' AND expires_at > NOW()"),
  ]);
  res.json({ dispatcher: dispatcher.status(), config: cfg, queue, live_offers: offers[0].live });
});

dispatchRoutes.put('/mode', async (req, res) => {
  const mode = v.oneOf(req.body?.mode, MODES, 'chế độ ghép');
  const maxOffers = req.body?.max_offers === undefined ? null : v.int(req.body.max_offers, 'số thợ mỗi đợt', { min: 1, max: 10 });
  const { rows } = await q(
    `UPDATE matching_configs SET mode = $1, max_offers = COALESCE($2, max_offers), updated_by = $3, updated_at = NOW()
     WHERE is_active RETURNING id`,
    [mode, maxOffers, req.user.id],
  );
  if (!rows[0]) throw new AppError(400, 'Chưa có cấu hình ghép cặp nào đang bật');
  res.json({ message: 'Đã đổi chế độ ghép', config: await getConfig() });
});

export const withdrawalRoutes = Router();

withdrawalRoutes.get('/', async (req, res) => {
  const status = req.query.status ? v.oneOf(req.query.status, ['pending', 'completed', 'rejected'], 'trạng thái') : null;
  const p = v.paging(req.query, 10);
  res.json({ ...(await listAllWithdrawals({ status, ...p })), page: p.page, pageSize: p.pageSize });
});

withdrawalRoutes.post('/:id/approve', async (req, res) => {
  res.json(await processWithdrawal(v.id(req.params.id), req.user.id, true, v.text(req.body?.note, 'ghi chú', { max: 500, required: false })));
});

withdrawalRoutes.post('/:id/reject', async (req, res) => {
  res.json(await processWithdrawal(v.id(req.params.id), req.user.id, false, v.text(req.body?.note, 'lý do', { max: 500 })));
});
