import * as catalogService from '../../services/admin/catalog.service.js';
import { AppError } from '../../utils/AppError.js';

const isId = (v) => /^\d+$/.test(String(v));

const text = (body, key, { required = false } = {}) => {
  if (body[key] === undefined) {
    if (required) throw new AppError(400, `Thiếu trường ${key}`);
    return undefined;
  }
  const value = String(body[key] ?? '').trim();
  if (required && !value) throw new AppError(400, `Thiếu trường ${key}`);
  return value || null;
};

const int = (body, key, { required = false, min = 0 } = {}) => {
  if (body[key] === undefined) {
    if (required) throw new AppError(400, `Thiếu trường ${key}`);
    return undefined;
  }
  const value = Number(body[key]);
  if (!Number.isInteger(value) || value < min) throw new AppError(400, `${key} phải là số nguyên ≥ ${min}`);
  return value;
};

const bool = (body, key) => {
  if (body[key] === undefined) return undefined;
  if (typeof body[key] !== 'boolean') throw new AppError(400, `${key} phải là true hoặc false`);
  return body[key];
};

const parseCategory = (body = {}, partial = false) => ({
  name: text(body, 'name', { required: !partial }),
  icon_url: text(body, 'icon_url'),
  description: text(body, 'description'),
  sort_order: int(body, 'sort_order'),
  is_active: partial ? bool(body, 'is_active') : undefined,
});

const parseService = (body = {}, partial = false) => ({
  category_id: int(body, 'category_id', { required: !partial, min: 1 }),
  name: text(body, 'name', { required: !partial }),
  description: text(body, 'description'),
  base_price: int(body, 'base_price', { required: !partial }),
  unit: text(body, 'unit'),
  warranty_days: int(body, 'warranty_days'),
  is_active: partial ? bool(body, 'is_active') : undefined,
});

export const listCategories = async (req, res) => {
  res.json({ items: await catalogService.listCategories() });
};

export const createCategory = async (req, res) => {
  const category = await catalogService.createCategory(parseCategory(req.body));
  res.status(201).json({ message: 'Đã tạo danh mục', category });
};

export const updateCategory = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã không hợp lệ');
  const category = await catalogService.updateCategory(req.params.id, parseCategory(req.body, true));
  res.json({ message: 'Đã cập nhật danh mục', category });
};

export const listServices = async (req, res) => {
  const { categoryId, search } = req.query;
  if (categoryId && !isId(categoryId)) throw new AppError(400, 'Mã danh mục không hợp lệ');
  res.json({ items: await catalogService.listServices({ categoryId, search: search?.trim() }) });
};

export const createService = async (req, res) => {
  const service = await catalogService.createService(parseService(req.body));
  res.status(201).json({ message: 'Đã tạo dịch vụ', service });
};

export const updateService = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã không hợp lệ');
  const service = await catalogService.updateService(req.params.id, parseService(req.body, true));
  res.json({ message: 'Đã cập nhật dịch vụ', service });
};