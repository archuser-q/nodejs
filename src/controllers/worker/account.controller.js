/** App thợ: đăng nhập, hồ sơ, giấy tờ, ngân hàng, bật/tắt nhận đơn, vị trí, trang chủ, danh mục, thông báo.  [B] */
import * as auth from '../../services/worker/auth.service.js';
import * as profile from '../../services/worker/profile.service.js';
import * as jobs from '../../services/worker/job.service.js';
import * as catalog from '../../services/customer/account.service.js';
import * as notifyService from '../../services/shared/notify.service.js';
import * as push from '../../services/shared/push.service.js';
import { getBank } from '../../services/worker/finance.service.js';
import { pool } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import * as v from '../../utils/validate.js';

const body = (req) => req.body ?? {};

// ── Đăng nhập ───────────────────────────────────────────────────────────────

export const register = async (req, res) => {
  const b = body(req);
  const result = await auth.register({
    fullName: v.text(b.full_name, 'họ tên', { min: 2, max: 100 }),
    email: v.email(b.email),
    phone: v.phone(b.phone, { required: false }),
    password: v.password(b.password),
  });
  res.status(201).json(result);
};

export const login = async (req, res) => {
  const b = body(req);
  const identifier = String(b.identifier ?? b.email ?? b.phone ?? '').trim();
  if (!identifier || !b.password) throw new AppError(400, 'Vui lòng nhập email/số điện thoại và mật khẩu');
  res.json(await auth.login(identifier, String(b.password)));
};

export const providers = (req, res) => res.json(auth.providers());

export const google = async (req, res) => {
  const b = body(req);
  res.json(await auth.socialLogin('google', { idToken: b.id_token || null, accessToken: b.access_token || null }));
};

export const facebook = async (req, res) => {
  res.json(await auth.socialLogin('facebook', { accessToken: body(req).access_token || null }));
};

export const forgotPassword = async (req, res) => {
  res.json(await auth.forgotPassword(v.email(body(req).email)));
};

export const resetPassword = async (req, res) => {
  const b = body(req);
  if (!/^\d{6}$/.test(String(b.code ?? ''))) throw new AppError(400, 'Mã xác nhận gồm 6 chữ số');
  await auth.resetPassword(v.email(b.email), String(b.code), v.password(b.new_password, 'mật khẩu mới'));
  res.json({ message: 'Đặt lại mật khẩu thành công, hãy đăng nhập bằng mật khẩu mới' });
};

export const changePassword = async (req, res) => {
  const b = body(req);
  await auth.changePassword(req.user.id, b.old_password ?? null, v.password(b.new_password, 'mật khẩu mới'));
  res.json({ message: 'Đổi mật khẩu thành công' });
};

export const authMe = (req, res) => res.json({ user: req.user });

// ── Hồ sơ & xác minh ────────────────────────────────────────────────────────

export const me = async (req, res) => res.json(await profile.me(req.user.id));

export const updateProfile = async (req, res) => {
  const b = body(req);
  const f = {};
  if (b.full_name !== undefined) f.full_name = v.text(b.full_name, 'họ tên', { min: 2, max: 100 });
  if (b.phone !== undefined) f.phone = v.phone(b.phone);
  if (b.avatar_url !== undefined) f.avatar_url = b.avatar_url === null || b.avatar_url === '' ? null : v.url(b.avatar_url, 'ảnh đại diện');
  if (b.bio !== undefined) f.bio = v.text(b.bio, 'giới thiệu', { max: 1000, required: false });
  if (b.experience_years !== undefined) f.experience_years = v.int(b.experience_years, 'số năm kinh nghiệm', { min: 0, max: 60 });
  if (b.service_radius_km !== undefined) f.service_radius_km = v.number(b.service_radius_km, 'bán kính nhận việc', { min: 1, max: 30 });
  res.json(await profile.updateProfile(req.user.id, f));
};

/**
 * PUT /skills { category_ids: [1, 2] }
 * Số năm kinh nghiệm là 1 con số chung của thợ (PATCH /profile experience_years), áp dụng cho mọi nhóm đã chọn.
 * Vẫn nhận dạng cũ { skills: [{ category_id }] } (bỏ qua years) để app bản cũ không lỗi.
 */
export const setSkills = async (req, res) => {
  const b = body(req);
  const raw = Array.isArray(b.category_ids) ? b.category_ids : Array.isArray(b.skills) ? b.skills.map((s) => s?.category_id) : null;
  if (!raw || !raw.length) throw new AppError(400, 'Chọn ít nhất 1 nhóm dịch vụ nhận làm');
  if (raw.length > 30) throw new AppError(400, 'Chọn tối đa 30 nhóm dịch vụ');
  res.json(await profile.setSkills(req.user.id, raw.map((x) => v.id(x, 'Nhóm dịch vụ'))));
};

export const listDocuments = async (req, res) => res.json(await profile.listDocuments(req.user.id));

export const addDocument = async (req, res) => {
  const b = body(req);
  const docType = v.oneOf(b.doc_type, profile.DOC_TYPES, 'loại giấy tờ');
  const { document, message } = await profile.addDocument(req.user.id, docType, v.url(b.file_url));
  res.status(201).json({ ...document, message });
};

export const deleteDocument = async (req, res) => {
  await profile.deleteDocument(req.user.id, v.id(req.params.id));
  res.json({ message: 'Đã xoá giấy tờ' });
};

export const submitVerification = async (req, res) => res.json(await profile.submitVerification(req.user.id));

export const getBankAccount = async (req, res) => res.json(await getBank(pool, req.user.id));

export const setBankAccount = async (req, res) => {
  const b = body(req);
  const holder = v.text(b.account_holder, 'tên chủ tài khoản', { min: 2, max: 150 }).toUpperCase();
  const number = String(b.account_number ?? '').replace(/\s/g, '');
  if (!/^\d{6,20}$/.test(number)) throw new AppError(400, 'Số tài khoản gồm 6–20 chữ số');
  res.json(await profile.setBank(req.user.id, { bank_name: v.text(b.bank_name, 'tên ngân hàng', { min: 2, max: 100 }), account_number: number, account_holder: holder }));
};

// ── Nhận đơn, vị trí, trang chủ ─────────────────────────────────────────────

const coords = (b, required) => {
  const hasLat = b.latitude !== undefined && b.latitude !== null;
  const hasLng = b.longitude !== undefined && b.longitude !== null;
  if (!hasLat && !hasLng && !required) return null;
  if (hasLat !== hasLng) throw new AppError(400, 'Cần gửi đủ cả vĩ độ và kinh độ');
  return {
    latitude: v.number(b.latitude, 'vĩ độ', { min: -90, max: 90 }),
    longitude: v.number(b.longitude, 'kinh độ', { min: -180, max: 180 }),
  };
};

export const home = async (req, res) => {
  res.json(await profile.home(req.user.id, { currentOffer: jobs.currentOffer, jobItems: jobs.jobItems }));
};

export const setAvailability = async (req, res) => {
  const b = body(req);
  if (typeof b.online !== 'boolean') throw new AppError(400, 'Thiếu trạng thái bật/tắt nhận đơn');
  res.json(await profile.setAvailability(req.user.id, b.online, coords(b, false)));
};

export const updateLocation = async (req, res) => {
  const c = coords(body(req), true);
  res.json(await profile.updateLocation(req.user.id, c.latitude, c.longitude));
};

// ── Danh mục dịch vụ (dùng lại API danh mục của app khách) ──────────────────

export const categories = async (req, res) => res.json(await catalog.listCategories());

export const services = async (req, res) => {
  const categoryId = req.query.category_id ? v.id(req.query.category_id, 'Danh mục') : null;
  res.json(await catalog.listServices({ categoryId, search: req.query.search?.trim() }));
};

// ── Thông báo (dùng chung bảng notifications với app khách) ─────────────────

export const listNotifications = async (req, res) => {
  const p = v.paging(req.query, 30);
  const result = await notifyService.listNotifications(req.user.id, { unreadOnly: req.query.unread_only === 'true', ...p });
  res.json({ ...result, page: p.page, pageSize: p.pageSize });
};

export const unreadCount = async (req, res) => res.json(await notifyService.unreadCount(req.user.id));

export const markNotificationRead = async (req, res) => {
  const n = await notifyService.markRead(req.user.id, v.id(req.params.id));
  if (!n) throw new AppError(404, 'Không tìm thấy thông báo');
  res.json(n);
};

export const markAllNotificationsRead = async (req, res) => res.json(await notifyService.markAllRead(req.user.id));

export const registerDevice = async (req, res) => {
  const b = body(req);
  await push.registerDevice(req.user.id, v.text(b.token, 'token', { max: 255 }), v.oneOf(b.platform, ['android', 'ios', 'web'], 'nền tảng'));
  res.status(201).json({ message: 'Đã đăng ký thiết bị' });
};

export const removeDevice = async (req, res) => {
  await push.removeDevice(req.user.id, String(req.params.token ?? ''));
  res.json({ message: 'Đã gỡ thiết bị' });
};
