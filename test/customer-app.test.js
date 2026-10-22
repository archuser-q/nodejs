/**
 * Kiểm thử tích hợp phần App Khách hàng sau khi ghép với App Thợ:
 * tài khoản (email / SĐT, quên & đổi mật khẩu, thiết bị push), quy tắc đặt đơn
 * (bỏ matching_mode, giờ hẹn ≥ 60 phút, ảnh tình trạng, bắt buộc SĐT), chi tiết đơn cho khách
 * (tiến độ tìm thợ, ảnh trước/sau, hạng thợ), chat có ảnh và thanh toán (không tiền mặt).
 *   npm test
 */
import './env.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers.js';

const { api, sql, off } = h;
let C;
let ADMIN;

before(async () => {
  await h.start();
});
after(async () => {
  await h.stop();
});

const status = (r, code) => assert.equal(r.status, code, JSON.stringify(r.body));
const advance = (w, id, st, extra = {}) => api('POST', `/api/worker/orders/${id}/status`, { token: w.token, body: { status: st, ...extra } });

/** Giờ hẹn hợp lệ: ngày mai lúc 10:00 giờ VN */
const tomorrowAt = (hourVn, minute = 0) => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(hourVn - 7, minute, 0, 0);
  return d.toISOString();
};

describe('App khách: tài khoản', () => {
  test('đăng ký bằng email, đăng nhập bằng email hoặc SĐT, chặn tài khoản thợ, đổi mật khẩu, quên mật khẩu', async () => {
    C = await h.reset();
    const email = `khach.${Date.now()}@test.vn`;
    const phone = h.phone();

    status(await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách A', email, password: '123' } }), 400);
    status(await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách A', email, password: '12345678' } }), 400); // quá phổ biến
    status(await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách A', email, password: 'chikhongso' } }), 400); // thiếu số
    status(await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách A', password: 'Khach2026' } }), 400);
    const reg = await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách A', email, phone, password: 'Khach2026' } });
    status(reg, 201);
    assert.equal(reg.body.user.role, 'customer');
    status(await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách B', email: email.toUpperCase(), password: 'Khach2026' } }), 409);

    status(await api('POST', '/api/customer/auth/login', { body: { identifier: email, password: 'Khach2026' } }), 200);
    status(await api('POST', '/api/customer/auth/login', { body: { identifier: phone, password: 'Khach2026' } }), 200);
    const wrong = await api('POST', '/api/customer/auth/login', { body: { identifier: email, password: 'sai-mat-khau' } });
    status(wrong, 401);
    assert.match(wrong.body.message, /Sai email/);

    // Tài khoản thợ không đăng nhập được app khách
    const w = await h.registerWorker('Thợ Thử');
    const asWorker = await api('POST', '/api/customer/auth/login', { body: { identifier: w.email, password: h.WORKER_PW } });
    status(asWorker, 403);
    assert.match(asWorker.body.message, /tài khoản thợ/);

    const token = reg.body.token;
    const me = await api('GET', '/api/customer/auth/me', { token });
    assert.equal(me.body.has_password, true);
    status(await api('POST', '/api/customer/auth/change-password', { token, body: { old_password: 'sai', new_password: 'matkhaumoi1' } }), 400);
    status(await api('POST', '/api/customer/auth/change-password', { token, body: { old_password: 'Khach2026', new_password: 'matkhaumoi1' } }), 200);
    status(await api('POST', '/api/customer/auth/login', { body: { identifier: email, password: 'matkhaumoi1' } }), 200);

    // Quên mật khẩu: môi trường test không có SMTP nên mã trả về debug_code
    const fp = await api('POST', '/api/customer/auth/forgot-password', { body: { email } });
    status(fp, 200);
    assert.match(fp.body.debug_code, /^\d{6}$/);
    status(await api('POST', '/api/customer/auth/reset-password', { body: { email, code: '000000', new_password: 'khac12345' } }), 400);
    status(await api('POST', '/api/customer/auth/reset-password', { body: { email, code: fp.body.debug_code, new_password: 'khac12345' } }), 200);
    status(await api('POST', '/api/customer/auth/login', { body: { identifier: email, password: 'khac12345' } }), 200);
    // Email của thợ: không tạo mã qua app khách
    const fpWorker = await api('POST', '/api/customer/auth/forgot-password', { body: { email: w.email } });
    assert.equal(fpWorker.body.debug_code, undefined);

    const prov = await api('GET', '/api/customer/auth/providers');
    status(prov, 200);
    assert.equal(prov.body.google, null);

    status(await api('POST', '/api/customer/device-tokens', { token, body: { token: 'ExponentPushToken[test-khach]', platform: 'android' } }), 201);
    assert.equal((await sql("SELECT user_id FROM device_tokens WHERE token = 'ExponentPushToken[test-khach]'"))[0].user_id, reg.body.user.id);
    status(await api('DELETE', `/api/customer/device-tokens/${encodeURIComponent('ExponentPushToken[test-khach]')}`, { token }), 200);
  });

  test('cập nhật hồ sơ: SĐT không trùng, không xoá được cả email lẫn SĐT', async () => {
    const a = await h.customer('Khách Một');
    const b = await h.customer('Khách Hai');
    const phoneB = (await sql('SELECT phone FROM users WHERE id = $1', [b.id]))[0].phone;
    status(await api('PATCH', '/api/customer/profile', { token: a.token, body: { phone: phoneB } }), 409);
    status(await api('PATCH', '/api/customer/profile', { token: a.token, body: { phone: '123' } }), 400);
    status(await api('PATCH', '/api/customer/profile', { token: a.token, body: { phone: null } }), 400);
    const ok = await api('PATCH', '/api/customer/profile', { token: a.token, body: { email: `mot.${Date.now()}@test.vn`, full_name: 'Khách Một Mới' } });
    status(ok, 200);
    assert.equal(ok.body.user.full_name, 'Khách Một Mới');
  });
});

describe('App khách: đặt đơn khớp với bộ điều phối và app thợ', () => {
  test('quy tắc đặt đơn: cần SĐT, bỏ qua matching_mode, giờ hẹn ≥ 60 phút trong khung giờ, ảnh tình trạng', async () => {
    C = await h.reset({ mode: 'instant', maxOffers: 1 });
    ADMIN = await h.adminCookie();

    // Khách đăng ký bằng email, chưa có SĐT -> chưa đặt được
    const reg = await api('POST', '/api/customer/auth/register', { body: { full_name: 'Khách Email', email: `e.${Date.now()}@test.vn`, password: 'Khach2026' } });
    const t = reg.body.token;
    const [lat, lng] = off();
    const addr = await api('POST', '/api/customer/addresses', { token: t, body: { address_text: '1 Tràng Tiền', lat, lng } });
    const noPhone = await api('POST', '/api/customer/orders', { token: t, body: { service_id: C.SVC, address_id: addr.body.id } });
    status(noPhone, 400);
    assert.match(noPhone.body.message, /số điện thoại/);
    status(await api('PATCH', '/api/customer/profile', { token: t, body: { phone: h.phone() } }), 200);

    const tooSoon = await api('POST', '/api/customer/orders', {
      token: t,
      body: { service_id: C.SVC, address_id: addr.body.id, scheduled_at: new Date(Date.now() + 30 * 60_000).toISOString() },
    });
    status(tooSoon, 400);
    assert.match(tooSoon.body.message, /60 phút/);
    const night = await api('POST', '/api/customer/orders', {
      token: t,
      body: { service_id: C.SVC, address_id: addr.body.id, scheduled_at: tomorrowAt(23) },
    });
    status(night, 400);
    assert.match(night.body.message, /7:00 đến 21:00/);
    status(
      await api('POST', '/api/customer/orders', {
        token: t,
        body: { service_id: C.SVC, address_id: addr.body.id, image_urls: Array(7).fill('http://x.vn/media/a.jpg') },
      }),
      400,
    );

    const img = await h.upload(t); // khách tải ảnh qua đúng API dùng chung
    const w = await h.readyWorker(ADMIN, { name: 'Thợ Nhận', at: off(0.5, 0.5) });
    const created = await api('POST', '/api/customer/orders', {
      token: t,
      body: { service_id: C.SVC, address_id: addr.body.id, description: 'Ổ cắm cháy đen', image_urls: [img], matching_mode: 'batch' },
    });
    status(created, 201);
    const oid = created.body.id;
    assert.deepEqual(created.body.image_urls, [img]);
    assert.equal(created.body.matching_mode, 'instant'); // chế độ do cấu hình admin quyết định, không theo khách
    assert.equal(created.body.searching.mode, 'instant');
    assert.ok(created.body.searching.rounds >= 1);
    assert.equal(created.body.photos.length, 0);

    // Thợ thấy ảnh tình trạng trong lời mời / chi tiết đơn
    const off1 = await h.offer(w);
    assert.equal(off1.order_id, oid);
    status(await api('POST', `/api/worker/offers/${off1.id}/accept`, { token: w.token }), 200);
    const job = (await api('GET', `/api/worker/orders/${oid}`, { token: w.token })).body;
    assert.deepEqual(job.image_urls, [img]);

    // Xem đơn chỉ đọc: không đổi số đợt mời
    const before = (await sql('SELECT COUNT(*)::int AS n FROM order_offers WHERE order_id = $1', [oid]))[0].n;
    let d = (await api('GET', `/api/customer/orders/${oid}`, { token: t })).body;
    d = (await api('GET', `/api/customer/orders/${oid}`, { token: t })).body;
    assert.equal((await sql('SELECT COUNT(*)::int AS n FROM order_offers WHERE order_id = $1', [oid]))[0].n, before);
    assert.equal(d.status, 'accepted');
    assert.equal(d.searching, null);
    assert.equal(d.worker.level.key, 'dong');
    assert.equal(d.worker.has_certificate, false);

    // Thợ làm đơn: kiểm tra an toàn, ảnh trước/sau -> khách thấy
    status(await advance(w, oid, 'on_the_way'), 200);
    status(await advance(w, oid, 'arrived'), 200);
    status(await advance(w, oid, 'in_progress', { safety_confirmed: true }), 200);
    status(await api('POST', `/api/worker/orders/${oid}/photos`, { token: w.token, body: { kind: 'before', urls: [await h.upload(w.token)] } }), 201);
    status(await api('POST', `/api/worker/orders/${oid}/photos`, { token: w.token, body: { kind: 'after', urls: [await h.upload(w.token)] } }), 201);
    d = (await api('GET', `/api/customer/orders/${oid}`, { token: t })).body;
    assert.ok(d.safety_checked_at);
    assert.deepEqual(d.photos.map((p) => p.kind), ['before', 'after']);

    // Chat có ảnh: khách gửi ảnh, thợ nhận đúng image_url
    const chatImg = await h.upload(t);
    status(await api('POST', `/api/customer/orders/${oid}/messages`, { token: t, body: {} }), 400);
    const m = await api('POST', `/api/customer/orders/${oid}/messages`, { token: t, body: { image_url: chatImg } });
    status(m, 201);
    assert.equal(m.body.content, null);
    const wm = (await api('GET', `/api/worker/orders/${oid}/messages`, { token: w.token })).body;
    assert.equal(wm.at(-1).image_url, chatImg);

    // Báo giá thợ tự rút -> khách thấy trạng thái 'cancelled'
    const q = await api('POST', `/api/worker/orders/${oid}/extra-quotes`, { token: w.token, body: { description: 'Thay dây', amount: 50000 } });
    status(q, 201);
    const qid = q.body.extra_quotes.find((x) => x.status === 'pending').id; // API thợ trả lại chi tiết đơn
    status(await api('POST', `/api/worker/orders/${oid}/extra-quotes/${qid}/cancel`, { token: w.token }), 200);
    d = (await api('GET', `/api/customer/orders/${oid}`, { token: t })).body;
    assert.equal(d.extra_quotes[0].status, 'cancelled');
    status(await api('POST', `/api/customer/orders/${oid}/quotes/${qid}/approve`, { token: t }), 404);

    const pub = (await api('GET', `/api/customer/workers/${w.id}`, { token: t })).body;
    assert.equal(pub.level.name, 'Thợ Đồng');

    // Xong việc: không nhận tiền mặt, còn đơn chưa trả thì chưa đặt đơn mới
    status(await advance(w, oid, 'completed'), 200);
    d = (await api('GET', `/api/customer/orders/${oid}`, { token: t })).body;
    assert.equal(d.can_pay, true);
    const cash = await api('POST', `/api/customer/orders/${oid}/payments`, { token: t, body: { method: 'cash' } });
    status(cash, 400);
    assert.match(cash.body.message, /không nhận tiền mặt/);
    const blocked = await api('POST', '/api/customer/orders', { token: t, body: { service_id: C.SVC, address_id: addr.body.id } });
    status(blocked, 400);
    assert.match(blocked.body.message, new RegExp(`chưa thanh toán đơn ${created.body.code}`));
    const pay = await api('POST', `/api/customer/orders/${oid}/payments`, { token: t, body: { method: 'momo' } });
    status(pay, 201);
    status(await api('POST', `/api/customer/payments/${pay.body.id}/sandbox-confirm`, { token: t }), 200);
    d = (await api('GET', `/api/customer/orders/${oid}`, { token: t })).body;
    assert.equal(d.can_pay, false);
    status(await api('POST', '/api/customer/orders', { token: t, body: { service_id: C.SVC, address_id: addr.body.id } }), 201);
  });

  test('lịch hẹn hợp lệ được nhận và thợ huỷ trước khi tới thì đơn quay lại tìm thợ', async () => {
    C = await h.reset({ mode: 'instant', maxOffers: 1 });
    ADMIN = await h.adminCookie();
    const cus = await h.customer('Khách Hẹn');
    const r = await api('POST', '/api/customer/orders', {
      token: cus.token,
      body: { service_id: C.SVC, address_id: cus.addressId, scheduled_at: tomorrowAt(10) },
    });
    status(r, 201);
    assert.equal(r.body.status, 'matching');
    status(await api('POST', `/api/customer/orders/${r.body.id}/cancel`, { token: cus.token, body: { reason: 'Đổi lịch' } }), 200);

    const w = await h.readyWorker(ADMIN, { name: 'Thợ Huỷ', at: off(0.3, 0.3) });
    const now = await api('POST', '/api/customer/orders', { token: cus.token, body: { service_id: C.SVC, address_id: cus.addressId } });
    const oid = now.body.id;
    const o = await h.offer(w);
    assert.equal(o.order_id, oid);
    status(await api('POST', `/api/worker/offers/${o.id}/accept`, { token: w.token }), 200);
    status(await api('POST', `/api/worker/orders/${oid}/cancel`, { token: w.token, body: { reason: 'Xe hỏng' } }), 200);
    const d = (await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body;
    assert.equal(d.status, 'matching');
    assert.equal(d.worker, null);
    assert.ok(d.searching);
    assert.equal(d.can_cancel, true);
  });
});
