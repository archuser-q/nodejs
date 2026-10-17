/**
 * [DEV-TOOLS] API giả lập thao tác của thợ để test app khách khi chưa có app thợ.
 * Chỉ bật khi NODE_ENV khác production và thư mục dev-tools còn tồn tại. Dùng qua dev-tools/simulate-worker.js.
 * :order nhận id hoặc mã đơn (VD 12 hoặc TN261017000012).
 */
import { Router } from 'express';
import * as flow from './worker-sim.service.js';
import { sendMessage } from '../src/services/customer/interaction.service.js';
import { q } from '../src/config/db.js';
import { AppError } from '../src/utils/AppError.js';

const router = Router();

const workerOf = async (orderId) => {
  const { rows } = await q('SELECT worker_id FROM orders WHERE id = $1', [orderId]);
  if (!rows[0]?.worker_id) throw new AppError(400, 'Đơn chưa có thợ nhận — chạy "accept" trước');
  return rows[0].worker_id;
};

router.param('order', async (req, res, next, value) => {
  req.orderId = await flow.resolveOrderId(value);
  next();
});

router.post('/orders/:order/accept', async (req, res) => {
  const workerId = req.body?.worker_id ? Number(req.body.worker_id) : null;
  res.json(await flow.acceptOrder(req.orderId, workerId));
});

router.post('/orders/:order/status', async (req, res) => {
  res.json(await flow.updateStatus(req.orderId, await workerOf(req.orderId), req.body?.status));
});

router.post('/orders/:order/move', async (req, res) => {
  const workerId = await workerOf(req.orderId);
  const { lat, lng, ratio } = req.body ?? {};
  res.json(
    lat !== undefined && lng !== undefined
      ? await flow.updateLocation(req.orderId, workerId, Number(lat), Number(lng))
      : await flow.stepTowardCustomer(req.orderId, workerId, Number(ratio) || 0.4),
  );
});

router.post('/orders/:order/quote', async (req, res) => {
  const amount = Number(req.body?.amount);
  const description = req.body?.description?.trim();
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError(400, 'amount phải là số nguyên dương');
  if (!description) throw new AppError(400, 'Thiếu description');
  res.json(await flow.createExtraQuote(req.orderId, await workerOf(req.orderId), amount, description));
});

router.post('/orders/:order/message', async (req, res) => {
  const content = req.body?.content?.trim();
  if (!content) throw new AppError(400, 'Thiếu content');
  res.json(await sendMessage(await workerOf(req.orderId), req.orderId, content));
});

router.post('/orders/:order/confirm-cash', async (req, res) => {
  res.json(await flow.confirmCash(req.orderId, await workerOf(req.orderId)));
});

export default router;
