/** Tiện ích cho test tích hợp: chạy server thật trên cổng ngẫu nhiên, gọi API như app, dọn dữ liệu. */
import './env.js';
import http from 'http';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { initSocket } from '../src/realtime/socket.js';
import { pool, q } from '../src/config/db.js';
import * as d from '../src/services/matching/dispatch.service.js';
import { getConfig } from '../src/services/matching/config.js';

let server;
let base;

export async function start() {
  server = http.createServer(app);
  initSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

export async function stop() {
  await new Promise((r) => server.close(r));
  await pool.end();
}

/** Gọi API: trả về { status, body } */
export async function api(method, path, { token, body, cookie, form } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

export const sql = async (text, params) => (await q(text, params)).rows;

/** Xoá sạch dữ liệu (giữ cấu trúc), nạp danh mục + cấu hình ghép mặc định */
export async function reset({ mode = 'instant', maxOffers = 2, timeout = 60 } = {}) {
  const { rows } = await q(
    "SELECT string_agg(format('%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('pgmigrations', 'spatial_ref_sys')",
  );
  await q(`TRUNCATE ${rows[0].t} RESTART IDENTITY CASCADE`);
  // 2 nhóm chuyên môn trong nghề điện (nền tảng chỉ gồm dịch vụ của thợ điện)
  const [cat] = await sql("INSERT INTO service_categories (name, sort_order) VALUES ('Sửa chữa điện', 1) RETURNING id");
  const [cat2] = await sql("INSERT INTO service_categories (name, sort_order) VALUES ('Đi dây & tủ điện', 2) RETURNING id");
  const [s1] = await sql("INSERT INTO services (category_id, name, base_price, unit, warranty_days) VALUES ($1, 'Sửa chập điện', 250000, 'lần', 30) RETURNING id", [cat.id]);
  const [s2] = await sql("INSERT INTO services (category_id, name, base_price, unit, warranty_days) VALUES ($1, 'Lắp đặt tủ điện', 500000, 'tủ', 90) RETURNING id", [cat2.id]);
  await setConfig({ mode, maxOffers, timeout });
  const hash = await bcrypt.hash('12345678', 10);
  await sql("INSERT INTO users (email, password_hash, full_name, role) VALUES ('admin@test.vn', $1, 'Admin', 'admin')", [hash]);
  return { CAT: cat.id, CAT2: cat2.id, SVC: s1.id, SVC2: s2.id };
}

export async function setConfig({ mode = 'instant', maxOffers = 2, timeout = 60, radius = 10, window = 10 } = {}) {
  await q('UPDATE matching_configs SET is_active = FALSE WHERE is_active');
  await q(
    `INSERT INTO matching_configs (name, w_distance, w_trust, w_skill, w_acceptance, w_workload, max_radius_km,
       offer_timeout_seconds, batch_window_seconds, mode, max_offers, is_active)
     VALUES ($1, 0.35, 0.30, 0.15, 0.10, 0.10, $2, $3, $4, $5, $6, TRUE)`,
    [`Test ${mode}`, radius, timeout, window, mode, maxOffers],
  );
}

// ── Toạ độ quanh tâm khu vực test (Hồ Gươm) ─────────────────────────────────
export const LAT0 = 21.0285;
export const LNG0 = 105.8542;
export const off = (dlatKm = 0, dlngKm = 0) => [LAT0 + dlatKm / 111.32, LNG0 + dlngKm / 103.8];

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
export const phone = () => `09${String(10_000_000 + ((Date.now() + seq++ * 7919) % 89_999_999)).slice(0, 8)}`;

export async function adminCookie() {
  const r = await api('POST', '/api/admin/auth/login', { body: { identifier: 'admin@test.vn', password: '12345678' } });
  return r.headers.get('set-cookie').split(';')[0];
}

// ── Khách hàng (API của app khách) ──────────────────────────────────────────
export async function customer(name = 'Nguyễn Thị Hoa', [lat, lng] = off()) {
  const r = await api('POST', '/api/customer/auth/register', { body: { full_name: name, phone: phone(), password: '12345678' } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const token = r.body.token;
  const a = await api('POST', '/api/customer/addresses', { token, body: { label: 'Nhà', address_text: '12 Ngõ Test, Hà Nội', lat, lng } });
  return { id: r.body.user.id, token, addressId: a.body.id };
}

export async function moveAddress(c, [lat, lng]) {
  await api('PATCH', `/api/customer/addresses/${c.addressId}`, { token: c.token, body: { lat, lng } });
}

export async function order(c, svc, { at, scheduledAt } = {}) {
  if (at) await moveAddress(c, at);
  const r = await api('POST', '/api/customer/orders', {
    token: c.token,
    body: { service_id: svc, address_id: c.addressId, description: 'Mất điện phòng bếp', ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) },
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.id;
}

// ── Thợ (API của app thợ) ───────────────────────────────────────────────────
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);

export async function upload(token) {
  const form = new FormData();
  form.append('file', new Blob([JPEG], { type: 'image/jpeg' }), 'a.jpg');
  const r = await api('POST', '/api/uploads', { token, form });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.url;
}

export async function registerWorker(name = 'Thợ Test') {
  const email = `tho.${uniq()}@test.vn`;
  const r = await api('POST', '/api/worker/auth/register', { body: { full_name: name, email, password: '12345678' } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return { id: r.body.user.id, token: r.body.token, email };
}

/** Thợ đi hết onboarding + admin duyệt + bật nhận đơn tại toạ độ cho trước */
export async function readyWorker(cookie, { name = 'Thợ', at = off(), trust = 0.8, categories, years = 5 } = {}) {
  const w = await registerWorker(name);
  const t = w.token;
  await api('PATCH', '/api/worker/profile', { token: t, body: { phone: phone(), experience_years: years } });
  const cats = categories ?? (await sql("SELECT id FROM service_categories WHERE name = 'Sửa chữa điện'")).map((x) => x.id);
  const s = await api('PUT', '/api/worker/skills', { token: t, body: { skills: cats.map((id) => ({ category_id: id, years })) } });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  for (const type of ['id_card_front', 'id_card_back', 'portrait']) {
    const r = await api('POST', '/api/worker/documents', { token: t, body: { doc_type: type, file_url: await upload(t) } });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  }
  const sub = await api('POST', '/api/worker/verification/submit', { token: t });
  if (sub.status !== 200) throw new Error(JSON.stringify(sub.body));
  const ap = await api('PATCH', `/api/admin/workers/${w.id}/verification`, { cookie, body: { status: 'approved' } });
  if (ap.status !== 200) throw new Error(JSON.stringify(ap.body));
  await sql('UPDATE workers SET trust_score = $2 WHERE user_id = $1', [w.id, trust]);
  const on = await api('PATCH', '/api/worker/availability', { token: t, body: { online: true, latitude: at[0], longitude: at[1] } });
  if (on.status !== 200) throw new Error(JSON.stringify(on.body));
  return w;
}

export const offer = async (w) => (await api('GET', '/api/worker/offers/current', { token: w.token })).body;

/** 1 nhịp điều phối như vòng chạy nền (không có chờ cửa sổ lô) */
export async function tick({ batch = false } = {}) {
  const cfg = await getConfig();
  await d.expireOffers();
  await d.closeStaleOffers();
  await d.adoptOrphans(cfg);
  await d.runDueInstant(cfg);
  const auto = await d.runAutoRound(cfg);
  const b = batch ? await d.runBatchRound(cfg) : null;
  await d.cancelOverdue();
  return { auto, batch: b };
}

export { d as dispatch };
