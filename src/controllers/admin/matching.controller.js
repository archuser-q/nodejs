import * as matchingService from '../../services/matching.service.js';
import { AppError } from '../../utils/AppError.js';

const WEIGHTS = ['w_distance', 'w_trust', 'w_skill', 'w_acceptance', 'w_workload'];
const isId = (v) => /^\d+$/.test(v);

const number = (body, key, min, max) => {
  const value = Number(body[key]);
  if (body[key] === undefined || body[key] === null || Number.isNaN(value) || value < min || value > max) {
    throw new AppError(400, `${key} phải nằm trong khoảng ${min}–${max}`);
  }
  return value;
};

const parseWeights = (body = {}) => {
  const data = {};
  for (const key of WEIGHTS) data[key] = number(body, key, 0, 1);

  const sum = WEIGHTS.reduce((s, key) => s + data[key], 0);
  if (Math.abs(sum - 1) > 0.001) throw new AppError(400, `Tổng trọng số phải bằng 1 (hiện tại: ${sum.toFixed(3)})`);

  data.max_radius_km = number(body, 'max_radius_km', 1, 50);
  return data;
};

const parseConfig = (body = {}) => {
  const name = String(body.name ?? '').trim();
  if (!name) throw new AppError(400, 'Vui lòng nhập tên cấu hình');

  const data = { name };
  for (const key of WEIGHTS) data[key] = number(body, key, 0, 1);

  const sum = WEIGHTS.reduce((s, key) => s + data[key], 0);
  if (Math.abs(sum - 1) > 0.001) throw new AppError(400, `Tổng trọng số phải bằng 1 (hiện tại: ${sum.toFixed(3)})`);

  data.max_radius_km = number(body, 'max_radius_km', 1, 50);
  data.offer_timeout_seconds = Math.round(number(body, 'offer_timeout_seconds', 10, 300));
  data.batch_window_seconds = Math.round(number(body, 'batch_window_seconds', 5, 120));
  // [B] Chế độ ghép do hệ thống chạy (instant | batch | auto) và k = số thợ nhận offer mỗi đợt.
  // Không gửi thì giữ nguyên giá trị cũ (tạo mới: auto, k = 3) để form hiện tại của dashboard vẫn dùng được.
  if (body.mode !== undefined) {
    if (!['instant', 'batch', 'auto'].includes(body.mode)) throw new AppError(400, 'mode must be instant, batch or auto');
    data.mode = body.mode;
  }
  if (body.max_offers !== undefined) data.max_offers = Math.round(number(body, 'max_offers', 1, 10));
  return data;
};

export const list = async (req, res) => {
  res.json({ items: await matchingService.listConfigs() });
};

export const create = async (req, res) => {
  const config = await matchingService.createConfig(parseConfig(req.body), req.user.id);
  res.status(201).json({ message: 'Đã tạo cấu hình', config });
};

export const update = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã không hợp lệ');
  await matchingService.updateConfig(req.params.id, parseConfig(req.body), req.user.id);
  res.json({ message: 'Đã cập nhật cấu hình' });
};

export const activate = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã không hợp lệ');
  await matchingService.activateConfig(req.params.id, req.user.id);
  res.json({ message: 'Đã áp dụng cấu hình' });
};

export const remove = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã không hợp lệ');
  await matchingService.deleteConfig(req.params.id);
  res.json({ message: 'Đã xoá cấu hình' });
};

export const simulate = async (req, res) => {
  const body = req.body ?? {};
  const config = parseWeights(body.config);
  const lat = number(body, 'lat', -90, 90);
  const lng = number(body, 'lng', -180, 180);
  const categoryId = number(body, 'category_id', 1, Number.MAX_SAFE_INTEGER);
  const limit = Math.round(number({ limit: body.limit ?? 20 }, 'limit', 1, 100));

  res.json(await matchingService.simulate({
    config, lat, lng, categoryId, includeOffline: body.include_offline === true, limit,
  }));
};