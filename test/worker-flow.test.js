/**
 * Kiểm thử tích hợp App Thợ + bộ điều phối ghép cặp trên PostgreSQL/PostGIS thật,
 * đi qua đúng API của app thợ, app khách và web quản trị.  [Thành viên B]
 *   npm test   (tạo lại CSDL test thonhanh_test rồi chạy toàn bộ)
 */
import './env.js';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import * as h from './helpers.js';
import { settings } from '../src/config/worker.js';
import { findCandidates } from '../src/services/candidate.js';

const { api, sql, off } = h;
let BASE;
let C; // id danh mục / dịch vụ
let ADMIN;

before(async () => {
  BASE = await h.start();
});
after(async () => {
  await h.stop();
});

const reset = async (opts) => {
  C = await h.reset(opts);
  ADMIN = await h.adminCookie();
};

const status = (r, code) => assert.equal(r.status, code, JSON.stringify(r.body));
const advance = (w, id, st, extra = {}) => api('POST', `/api/worker/orders/${id}/status`, { token: w.token, body: { status: st, ...extra } });

// ═════════════════════════════════════════════════════════════════════════
describe('Đăng nhập & tài khoản', () => {
  beforeEach(() => reset());

  test('đăng ký bằng email, đăng nhập bằng email / SĐT, chặn sai vai trò', async () => {
    const w = await h.registerWorker('Thợ Một');
    status(await api('POST', '/api/worker/auth/register', { body: { full_name: 'X', email: w.email, password: '12345678' } }), 400); // họ tên quá ngắn
    status(await api('POST', '/api/worker/auth/register', { body: { full_name: 'Thợ Hai', email: w.email.toUpperCase(), password: '12345678' } }), 409);
    status(await api('POST', '/api/worker/auth/register', { body: { full_name: 'Thợ Hai', email: 'a@b.vn', password: '123' } }), 400);

    const login = await api('POST', '/api/worker/auth/login', { body: { identifier: w.email, password: '12345678' } });
    status(login, 200);
    assert.ok(login.body.token && login.body.user.role === 'worker');
    status(await api('POST', '/api/worker/auth/login', { body: { identifier: w.email, password: 'sai-mat-khau' } }), 401);

    const p = h.phone();
    status(await api('PATCH', '/api/worker/profile', { token: w.token, body: { phone: p } }), 200);
    status(await api('POST', '/api/worker/auth/login', { body: { identifier: p, password: '12345678' } }), 200);

    // tài khoản khách không dùng app thợ và ngược lại
    const c = await h.customer();
    const r = await api('POST', '/api/worker/auth/login', { body: { identifier: (await sql('SELECT phone FROM users WHERE id = $1', [c.id]))[0].phone, password: '12345678' } });
    status(r, 403);
    assert.match(r.body.message, /khách hàng/);
    status(await api('GET', '/api/worker/me', { token: c.token }), 403);
    status(await api('GET', '/api/customer/orders', { token: w.token }), 403);
    status(await api('GET', '/api/worker/me'), 401);

    const me = await api('GET', '/api/worker/auth/me', { token: w.token });
    assert.equal(me.body.user.email, w.email);
    status(await api('POST', '/api/worker/auth/change-password', { token: w.token, body: { old_password: 'sai', new_password: 'abcdefgh' } }), 400);
    status(await api('POST', '/api/worker/auth/change-password', { token: w.token, body: { old_password: '12345678', new_password: 'abcdefgh' } }), 200);
    status(await api('POST', '/api/worker/auth/login', { body: { identifier: w.email, password: 'abcdefgh' } }), 200);
  });

  test('quên mật khẩu: mã 6 số, chờ 1 phút mới gửi lại, sai mã bị đếm, đặt lại xong đăng nhập được', async () => {
    const w = await h.registerWorker();
    const r = await api('POST', '/api/worker/auth/forgot-password', { body: { email: w.email } });
    status(r, 200);
    assert.match(r.body.debug_code, /^\d{6}$/); // chưa cấu hình SMTP + không phải production
    status(await api('POST', '/api/worker/auth/forgot-password', { body: { email: w.email } }), 429);
    const unknown = await api('POST', '/api/worker/auth/forgot-password', { body: { email: 'khong.ton.tai@test.vn' } });
    assert.equal(unknown.status, 200); // không lộ email nào đã đăng ký
    assert.equal(unknown.body.debug_code, undefined);
    const wrong = r.body.debug_code === '000000' ? '111111' : '000000';
    status(await api('POST', '/api/worker/auth/reset-password', { body: { email: w.email, code: wrong, new_password: 'matkhaumoi' } }), 400);
    status(await api('POST', '/api/worker/auth/reset-password', { body: { email: w.email, code: r.body.debug_code, new_password: 'matkhaumoi' } }), 200);
    status(await api('POST', '/api/worker/auth/reset-password', { body: { email: w.email, code: r.body.debug_code, new_password: 'matkhaumoi2' } }), 400); // mã dùng 1 lần
    status(await api('POST', '/api/worker/auth/login', { body: { identifier: w.email, password: 'matkhaumoi' } }), 200);
  });

  test('Google / Facebook: server tự xác minh token, tạo tài khoản thợ mới hoặc liên kết theo email', async () => {
    const realFetch = globalThis.fetch;
    Object.assign(settings, { googleWebClientId: 'web-client', facebookAppId: 'fb-app', facebookAppSecret: 'secret' });
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
      if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        if (u.includes('id_token=bad')) return json({ error: 'invalid' }, 400);
        if (u.includes('id_token=other-app')) return json({ aud: 'app-khac', iss: 'accounts.google.com', sub: 'g9' });
        return json({ aud: 'web-client', iss: 'https://accounts.google.com', sub: 'g-123', email: 'Google.Tho@Gmail.com', email_verified: 'true', name: 'Thợ Google', picture: 'https://x/a.png' });
      }
      if (u.startsWith('https://graph.facebook.com/debug_token')) return json({ data: { is_valid: true, app_id: 'fb-app' } });
      if (u.startsWith('https://graph.facebook.com/me')) return json({ id: 'fb-1', name: 'Thợ Facebook', email: 'google.tho@gmail.com' });
      return realFetch(url, opts);
    };
    try {
      const prov = await api('GET', '/api/worker/auth/providers');
      assert.equal(prov.body.google.web_client_id, 'web-client');
      assert.equal(prov.body.facebook.app_id, 'fb-app');

      const g = await api('POST', '/api/worker/auth/google', { body: { id_token: 'good' } });
      status(g, 200);
      assert.equal(g.body.is_new, true);
      assert.equal(g.body.user.email, 'google.tho@gmail.com');
      assert.equal(g.body.user.avatar_url, 'https://x/a.png');
      const again = await api('POST', '/api/worker/auth/google', { body: { id_token: 'good' } });
      assert.equal(again.body.is_new, false);
      assert.equal(again.body.user.id, g.body.user.id);
      status(await api('POST', '/api/worker/auth/google', { body: { id_token: 'bad' } }), 401);
      status(await api('POST', '/api/worker/auth/google', { body: { id_token: 'other-app' } }), 401);

      // Facebook cùng email đã xác minh -> liên kết vào đúng tài khoản Google ở trên
      const f = await api('POST', '/api/worker/auth/facebook', { body: { access_token: 'fb-token' } });
      status(f, 200);
      assert.equal(f.body.user.id, g.body.user.id);
      assert.equal(f.body.is_new, false);
      // chưa có mật khẩu -> đăng nhập bằng mật khẩu báo dùng Google/Facebook
      const pw = await api('POST', '/api/worker/auth/login', { body: { identifier: 'google.tho@gmail.com', password: '12345678' } });
      status(pw, 401);
      assert.match(pw.body.message, /Google/);
      // đặt mật khẩu lần đầu không cần mật khẩu cũ
      status(await api('POST', '/api/worker/auth/change-password', { token: g.body.token, body: { new_password: 'matkhau123' } }), 200);
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(settings, { googleWebClientId: null, facebookAppId: null, facebookAppSecret: null });
    }
  });

  test('tải ảnh: chỉ nhận ảnh thật, cần đăng nhập, phục vụ lại qua /media', async () => {
    const w = await h.registerWorker();
    const url = await h.upload(w.token);
    assert.match(url, /\/media\/\d{4}\/\d{2}\/[0-9a-f]{32}\.jpg$/);
    const got = await fetch(url.replace(/^https?:\/\/[^/]+/, BASE));
    assert.equal(got.status, 200);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('not an image at all')], { type: 'image/jpeg' }), 'x.jpg');
    status(await api('POST', '/api/uploads', { token: w.token, form }), 400);
    status(await api('POST', '/api/uploads', { form: new FormData() }), 401);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('Hồ sơ & xác minh', () => {
  beforeEach(() => reset());

  test('onboarding: thiếu gì báo nấy, gửi hồ sơ, admin từ chối thì tải lại và gửi lại được', async () => {
    const w = await h.registerWorker('Lê Văn Mới');
    let me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.equal(me.onboarding.can_submit, false);
    assert.equal(me.onboarding.missing.length, 5); // SĐT, nhóm dịch vụ, 3 giấy tờ
    status(await api('POST', '/api/worker/verification/submit', { token: w.token }), 400);
    status(await api('PATCH', '/api/worker/availability', { token: w.token, body: { online: true, latitude: 21, longitude: 105 } }), 400);

    await api('PATCH', '/api/worker/profile', { token: w.token, body: { phone: h.phone(), bio: 'Thợ điện 5 năm', service_radius_km: 8 } });
    status(await api('PUT', '/api/worker/skills', { token: w.token, body: { skills: [{ category_id: 99999, years: 2 }] } }), 400);
    const sk = await api('PUT', '/api/worker/skills', { token: w.token, body: { skills: [{ category_id: C.CAT, years: 6 }] } });
    status(sk, 200);
    assert.equal(sk.body[0].category_name, 'Sửa chữa điện');
    assert.equal(sk.body[0].years, 6);
    status(await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: 'id_card_front', file_url: 'ftp://x' } }), 400);
    for (const t of ['id_card_front', 'id_card_back', 'portrait']) {
      status(await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: t, file_url: await h.upload(w.token) } }), 201);
    }
    me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.deepEqual(me.onboarding.missing, []);
    assert.equal(me.onboarding.can_submit, true);
    assert.equal(me.profile.service_radius_km, 8);

    const sub = await api('POST', '/api/worker/verification/submit', { token: w.token });
    status(sub, 200);
    assert.ok(sub.body.onboarding.submitted_at);
    assert.equal(sub.body.onboarding.can_submit, false);
    status(await api('POST', '/api/worker/verification/submit', { token: w.token }), 400); // đã gửi rồi
    // admin được báo có hồ sơ chờ duyệt
    assert.equal((await sql("SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'worker_verification'"))[0].n, 1);

    // admin (API của web quản trị) từ chối -> thợ thấy lý do, tải lại và gửi lại
    status(await api('PATCH', `/api/admin/workers/${w.id}/verification`, { cookie: ADMIN, body: { status: 'rejected', note: 'Ảnh CCCD bị mờ' } }), 200);
    me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.equal(me.onboarding.verification_status, 'rejected');
    const note = (await api('GET', '/api/worker/notifications', { token: w.token })).body.items[0];
    assert.equal(note.type, 'verification');
    assert.equal(note.body, 'Ảnh CCCD bị mờ');
    assert.ok(me.onboarding.reject_reasons.some((r) => r.includes('mờ')));
    for (const t of ['id_card_front', 'id_card_back', 'portrait']) {
      await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: t, file_url: await h.upload(w.token) } });
    }
    status(await api('POST', '/api/worker/verification/submit', { token: w.token }), 200);
    status(await api('PATCH', `/api/admin/workers/${w.id}/verification`, { cookie: ADMIN, body: { status: 'approved' } }), 200);
    me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.equal(me.profile.verification_status, 'approved');
    // bật nhận đơn cần vị trí
    status(await api('PATCH', '/api/worker/availability', { token: w.token, body: { online: true } }), 400);
    const on = await api('PATCH', '/api/worker/availability', { token: w.token, body: { online: true, latitude: 21.03, longitude: 105.85 } });
    status(on, 200);
    assert.equal(on.body.availability, 'online');
    assert.equal(on.body.location_fresh, true);
  });

  test('giấy tờ đã duyệt: không gỡ được, gửi ảnh mới thì chờ duyệt mà ảnh cũ vẫn hiệu lực; chứng chỉ gỡ được', async () => {
    const w = await h.readyWorker(ADMIN, { name: 'Thợ Cũ' });
    const docs = (await api('GET', '/api/worker/documents', { token: w.token })).body;
    const front = docs.find((x) => x.doc_type === 'id_card_front');
    assert.equal(front.status, 'approved');
    status(await api('DELETE', `/api/worker/documents/${front.id}`, { token: w.token }), 400);

    const r = await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: 'id_card_front', file_url: await h.upload(w.token) } });
    status(r, 201);
    assert.equal(r.body.status, 'pending');
    assert.match(r.body.message, /ảnh cũ vẫn dùng/);
    // gửi lần nữa khi đang chờ duyệt: thay ảnh, không tạo bản trùng
    const r2 = await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: 'id_card_front', file_url: await h.upload(w.token) } });
    assert.equal(r2.body.id, r.body.id);
    const me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.equal(me.profile.verification_status, 'approved'); // vẫn nhận việc bình thường
    assert.equal(me.onboarding.documents.id_card_front, 'pending');
    status(await api('DELETE', `/api/worker/documents/${r.body.id}`, { token: w.token }), 200); // bản chờ duyệt gỡ được

    const cert = await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: 'certificate', file_url: await h.upload(w.token) } });
    await sql("UPDATE worker_documents SET status = 'approved' WHERE id = $1", [cert.body.id]);
    status(await api('DELETE', `/api/worker/documents/${cert.body.id}`, { token: w.token }), 200);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('Luồng đơn đầy đủ (chế độ tức thời)', () => {
  beforeEach(() => reset({ mode: 'instant', maxOffers: 2 }));

  test('offer -> nhận -> đi -> đến -> an toàn -> báo giá -> ảnh -> xong -> tiền mặt -> ví -> đánh giá -> rút tiền', async () => {
    const w1 = await h.readyWorker(ADMIN, { name: 'Thợ Một', at: off(0.5, 0), trust: 0.9 });
    const w2 = await h.readyWorker(ADMIN, { name: 'Thợ Hai', at: off(1.5, 0), trust: 0.7 });
    const cus = await h.customer('Nguyễn Thị Hoa');
    const oid = await h.order(cus, C.SVC);

    // tức thời: đợt 1 gửi ngay cho top-2
    const o1 = await h.offer(w1);
    const o2 = await h.offer(w2);
    assert.ok(o1 && o2 && o1.order_id === oid && o2.order_id === oid);
    assert.ok(o1.match_score > o2.match_score); // gần hơn + tin cậy cao hơn
    assert.equal(o1.customer_name, 'Hoa'); // chưa nhận: chỉ thấy tên gọi
    assert.equal(o1.estimated_earning, 250000 - 37500);
    assert.ok(o1.expires_in_seconds > 0 && o1.expires_in_seconds <= 60 && o1.timeout_seconds === 60);
    assert.equal(o1.round, 1);
    let c = (await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body;
    assert.equal(c.status, 'matching');
    assert.equal(c.matching_mode, 'instant');
    assert.deepEqual(c.offers, { total: 2, waiting: 2 });

    // thợ 1 nhận -> thợ 2 mất lời mời, nhận muộn bị từ chối
    const acc = await api('POST', `/api/worker/offers/${o1.id}/accept`, { token: w1.token });
    status(acc, 200);
    assert.equal(acc.body.status, 'accepted');
    assert.ok(acc.body.customer.phone);
    assert.equal(acc.body.customer.full_name, 'Nguyễn Thị Hoa');
    assert.equal(acc.body.next_status, 'on_the_way');
    assert.equal(await h.offer(w2), null);
    status(await api('POST', `/api/worker/offers/${o2.id}/accept`, { token: w2.token }), 409);
    const home = (await api('GET', '/api/worker/home', { token: w1.token })).body;
    assert.equal(home.availability, 'busy');
    assert.equal(home.active_job.id, oid);
    c = (await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body;
    assert.equal(c.status, 'accepted');
    assert.equal(c.worker.id, w1.id);

    // nhảy bước bị chặn
    status(await advance(w1, oid, 'arrived'), 400);
    for (const st of ['on_the_way', 'arrived']) {
      const r = await advance(w1, oid, st);
      status(r, 200);
      assert.equal(r.body.status, st);
    }
    status(await advance(w1, oid, 'arrived'), 409);

    // vị trí khi đang làm đơn: lưu vết + khách theo dõi được
    const [lat, lng] = off(0.1, 0.1);
    status(await api('PATCH', '/api/worker/location', { token: w1.token, body: { latitude: lat, longitude: lng } }), 200);
    assert.ok((await sql('SELECT COUNT(*)::int AS n FROM worker_location_logs WHERE worker_id = $1', [w1.id]))[0].n >= 1);
    const tr = (await api('GET', `/api/customer/orders/${oid}/tracking`, { token: cus.token })).body;
    assert.ok(Math.abs(tr.worker_lat - lat) < 1e-9);

    // ảnh trước khi sửa; ảnh sau chưa được thêm khi chưa sửa
    status(await api('POST', `/api/worker/orders/${oid}/photos`, { token: w1.token, body: { kind: 'before', urls: [await h.upload(w1.token)] } }), 201);
    status(await api('POST', `/api/worker/orders/${oid}/photos`, { token: w1.token, body: { kind: 'after', urls: [await h.upload(w1.token)] } }), 400);
    // chưa xác nhận an toàn điện -> không cho bắt đầu sửa
    const unsafe = await advance(w1, oid, 'in_progress');
    status(unsafe, 400);
    assert.match(unsafe.body.message, /an toàn/);
    const working = await advance(w1, oid, 'in_progress', { safety_confirmed: true });
    status(working, 200);
    assert.ok(working.body.safety_checked_at && working.body.started_at);

    // báo giá phát sinh -> khách duyệt (API app khách)
    const qr = await api('POST', `/api/worker/orders/${oid}/extra-quotes`, { token: w1.token, body: { description: 'Thay dây điện 10m', amount: 120000 } });
    status(qr, 201);
    assert.equal(qr.body.has_pending_quote, true);
    assert.equal(qr.body.can_quote, false);
    status(await api('POST', `/api/worker/orders/${oid}/extra-quotes`, { token: w1.token, body: { description: 'Thêm nữa', amount: 1000 } }), 400);
    status(await advance(w1, oid, 'completed'), 400); // còn báo giá chờ duyệt
    const qid = qr.body.extra_quotes[0].id;
    const ap = await api('POST', `/api/customer/orders/${oid}/quotes/${qid}/approve`, { token: cus.token });
    status(ap, 200);
    assert.equal(ap.body.total_amount, 370000);

    // chưa có ảnh sau -> chưa xong được
    const noPhoto = await advance(w1, oid, 'completed');
    status(noPhoto, 400);
    assert.match(noPhoto.body.message, /ảnh/);
    await api('POST', `/api/worker/orders/${oid}/photos`, { token: w1.token, body: { kind: 'after', urls: [await h.upload(w1.token), await h.upload(w1.token)] } });
    const done = await advance(w1, oid, 'completed');
    status(done, 200);
    assert.equal(done.body.final_price, 370000);
    assert.equal(done.body.warranty.status, 'active');
    assert.equal(done.body.can_confirm_cash, true);
    assert.equal(done.body.amount_to_collect, 370000);
    assert.deepEqual(done.body.photos.map((p) => p.kind), ['before', 'after', 'after']);
    assert.equal((await api('GET', '/api/worker/home', { token: w1.token })).body.availability, 'online');
    c = (await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body;
    assert.equal(c.status, 'completed');
    assert.equal(c.can_pay, true);

    // khách chọn tiền mặt -> thợ xác nhận -> ví trừ hoa hồng 15%
    status(await api('POST', `/api/customer/orders/${oid}/payments`, { token: cus.token, body: { method: 'cash' } }), 201);
    assert.equal((await api('GET', `/api/worker/orders/${oid}`, { token: w1.token })).body.customer_chose_cash, true);
    const cash = await api('POST', `/api/worker/orders/${oid}/confirm-cash`, { token: w1.token });
    status(cash, 200);
    assert.equal(cash.body.paid, true);
    assert.deepEqual(cash.body.earning, { gross_amount: 370000, commission_amount: 55500, net_amount: 314500 });
    status(await api('POST', `/api/worker/orders/${oid}/confirm-cash`, { token: w1.token }), 400);
    const wallet = (await api('GET', '/api/worker/wallet', { token: w1.token })).body;
    assert.equal(wallet.balance, -55500);
    assert.equal(wallet.recent[0].type, 'commission');
    assert.equal(wallet.recent[0].balance_after, -55500);
    const sToday = (await api('GET', '/api/worker/earnings/summary?period=today', { token: w1.token })).body;
    assert.equal(sToday.totals.net, 314500);
    assert.equal(sToday.totals.cash_collected, 370000);
    assert.equal(sToday.totals.orders, 1);
    assert.equal(sToday.chart.length, 7);
    assert.equal(sToday.chart.at(-1).net, 314500);
    assert.equal((await api('GET', '/api/worker/earnings/summary?period=month', { token: w1.token })).body.totals.net, 314500);
    const hist = (await api('GET', '/api/worker/earnings', { token: w1.token })).body;
    assert.equal(hist.items[0].net_amount, 314500);
    assert.equal(hist.pageSize, 20);
    c = (await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body;
    assert.equal(c.can_pay, false);
    assert.equal(c.payments[0].status, 'success');

    // khách đánh giá -> thợ thấy ngay ở danh sách đơn + trang đánh giá
    status(await api('POST', `/api/customer/orders/${oid}/review`, { token: cus.token, body: { rating: 5, comment: 'Thợ nhiệt tình' } }), 201);
    const rv = (await api('GET', '/api/worker/reviews', { token: w1.token })).body;
    assert.equal(rv.summary.rating_count, 1);
    assert.equal(rv.items[0].customer_name, 'Hoa');
    const doneList = (await api('GET', '/api/worker/orders?group=completed', { token: w1.token })).body;
    assert.equal(doneList.items.find((x) => x.id === oid).rating, 5);
    const perf = (await api('GET', '/api/worker/performance', { token: w1.token })).body;
    assert.equal(perf.jobs_completed, 1);
    assert.equal(perf.acceptance_rate, 1);
    assert.equal(perf.total_completed, 1);
    assert.equal(perf.rating_avg, 5);

    // chat với khách (dùng chung bảng messages với app khách), kể cả ảnh
    status(await api('POST', `/api/worker/orders/${oid}/messages`, { token: w1.token, body: { content: 'Em đã sửa xong ạ' } }), 201);
    const img = await api('POST', `/api/worker/orders/${oid}/messages`, { token: w1.token, body: { image_url: await h.upload(w1.token) } });
    status(img, 201);
    assert.equal(img.body.is_mine, true);
    const msgs = (await api('GET', `/api/customer/orders/${oid}/messages`, { token: cus.token })).body;
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].image_url);
    await api('POST', `/api/customer/orders/${oid}/messages`, { token: cus.token, body: { content: 'Cảm ơn anh' } });
    assert.equal((await api('GET', '/api/worker/orders?group=history', { token: w1.token })).body.items[0].unread_messages, 1);
    await api('POST', `/api/worker/orders/${oid}/messages/read`, { token: w1.token });
    assert.equal((await api('GET', '/api/worker/orders?group=history', { token: w1.token })).body.items[0].unread_messages, 0);

    // báo cáo sự cố vào luồng khiếu nại admin, KHÔNG hiện trong danh sách khiếu nại của khách
    status(await api('POST', `/api/worker/orders/${oid}/report`, { token: w1.token, body: { reason: 'Khách thanh toán chậm' } }), 201);
    status(await api('POST', `/api/worker/orders/${oid}/report`, { token: w1.token, body: { reason: 'Lần hai' } }), 400);
    const reps = (await api('GET', '/api/worker/reports', { token: w1.token })).body;
    assert.equal(reps.items[0].reason, 'Khách thanh toán chậm');
    const adminList = (await api('GET', '/api/admin/complaints', { cookie: ADMIN })).body;
    assert.ok(adminList.items.some((x) => x.title === '[Thợ báo cáo] Khách thanh toán chậm'));
    assert.equal((await api('GET', '/api/customer/complaints', { token: cus.token })).body.length, 0);

    // ví: rút tiền cần ngân hàng, số dư đủ, tối thiểu 50.000đ
    status(await api('POST', '/api/worker/wallet/withdrawals', { token: w1.token, body: { amount: 100000 } }), 400);
    const bank = await api('PUT', '/api/worker/bank-account', { token: w1.token, body: { bank_name: 'Vietcombank', account_number: '0123 456 789', account_holder: 'thợ một' } });
    status(bank, 200);
    assert.equal(bank.body.account_number, '0123456789');
    status(await api('POST', '/api/worker/wallet/withdrawals', { token: w1.token, body: { amount: 100000 } }), 400); // ví âm
    status(await api('POST', '/api/worker/wallet/topup', { token: w1.token, body: { amount: 500000, method: 'momo' } }), 200);
    const wd = await api('POST', '/api/worker/wallet/withdrawals', { token: w1.token, body: { amount: 200000 } });
    status(wd, 201);
    assert.equal(wd.body.status, 'completed');
    assert.equal(wd.body.account_holder, 'THỢ MỘT');
    assert.equal((await api('GET', '/api/worker/wallet', { token: w1.token })).body.balance, -55500 + 500000 - 200000);
    status(await api('POST', '/api/worker/wallet/withdrawals', { token: w1.token, body: { amount: 30000 } }), 400);
    const txs = (await api('GET', '/api/worker/wallet/transactions', { token: w1.token })).body;
    assert.deepEqual(txs.items.map((t) => t.type), ['withdraw', 'topup', 'commission']);
  });

  test('khách trả online (MoMo sandbox) -> ví thợ cộng phần thực nhận', async () => {
    const w = await h.readyWorker(ADMIN, { at: off(0.3, 0) });
    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);
    await api('POST', `/api/worker/offers/${(await h.offer(w)).id}/accept`, { token: w.token });
    await advance(w, oid, 'on_the_way');
    await advance(w, oid, 'arrived');
    await advance(w, oid, 'in_progress', { safety_confirmed: true });
    await api('POST', `/api/worker/orders/${oid}/photos`, { token: w.token, body: { kind: 'after', urls: [await h.upload(w.token)] } });
    await advance(w, oid, 'completed');
    const pay = await api('POST', `/api/customer/orders/${oid}/payments`, { token: cus.token, body: { method: 'momo' } });
    status(pay, 201);
    status(await api('POST', `/api/customer/payments/${pay.body.id}/sandbox-confirm`, { token: cus.token }), 200);
    const wallet = (await api('GET', '/api/worker/wallet', { token: w.token })).body;
    assert.equal(wallet.balance, 250000 - 37500);
    assert.equal(wallet.recent[0].type, 'earning');
    const [o] = await sql('SELECT commission_amount FROM orders WHERE id = $1', [oid]);
    assert.equal(Number(o.commission_amount), 37500);
    const job = (await api('GET', `/api/worker/orders/${oid}`, { token: w.token })).body;
    assert.equal(job.payment_method, 'momo');
    assert.equal(job.net_earning, 212500);
  });

  test('ví âm quá hạn mức thì không bật nhận đơn được và không được ghép', async () => {
    const w = await h.readyWorker(ADMIN, { at: off(0.3, 0) });
    await sql('UPDATE workers SET wallet_balance = -600000 WHERE user_id = $1', [w.id]);
    const cus = await h.customer();
    await h.order(cus, C.SVC);
    assert.equal(await h.offer(w), null);
    await api('PATCH', '/api/worker/availability', { token: w.token, body: { online: false } });
    const r = await api('PATCH', '/api/worker/availability', { token: w.token, body: { online: true, latitude: off()[0], longitude: off()[1] } });
    status(r, 400);
    assert.match(r.body.message, /Ví đang âm/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('Bộ điều phối', () => {
  test('từ chối -> đợt sau ngay; hết giờ -> expired; quá hạn chờ -> huỷ đơn; tắt nhận đơn -> offer đi tiếp', async () => {
    await reset({ mode: 'instant', maxOffers: 2 });
    const a = await h.readyWorker(ADMIN, { name: 'Thợ A', at: off(0.3, 0.3), trust: 0.9 });
    const b = await h.readyWorker(ADMIN, { name: 'Thợ B', at: off(0.6, 0.3), trust: 0.8 });
    const c = await h.readyWorker(ADMIN, { name: 'Thợ C', at: off(2.5, 0.3), trust: 0.5 });
    const cus = await h.customer('Khách', off(0.3, 0.3));
    const oid = await h.order(cus, C.SVC);
    const oa = await h.offer(a);
    const ob = await h.offer(b);
    assert.ok(oa && ob);
    assert.equal(await h.offer(c), null); // top-2 trước

    await api('POST', `/api/worker/offers/${oa.id}/reject`, { token: a.token, body: { reason: 'Đang bận việc khác' } });
    assert.equal(await h.offer(c), null); // còn offer của B
    await api('POST', `/api/worker/offers/${ob.id}/reject`, { token: b.token, body: { reason: 'Quá xa' } });
    const oc = await h.offer(c);
    assert.ok(oc && oc.order_id === oid && oc.round === 2);
    assert.equal(await h.offer(a), null); // không mời lại thợ đã từ chối
    // tỷ lệ nhận đơn của A giảm (có làm mượt: (0 + 3) / (1 + 3))
    assert.equal(Number((await sql('SELECT acceptance_rate FROM workers WHERE user_id = $1', [a.id]))[0].acceptance_rate), 0.75);

    // C không trả lời -> hết hạn -> không còn ai -> đơn chờ; quá hạn thì hệ thống huỷ
    await sql("UPDATE order_offers SET expires_at = NOW() - interval '1 second' WHERE id = $1", [oc.id]);
    await h.tick();
    assert.equal((await sql('SELECT status FROM order_offers WHERE id = $1', [oc.id]))[0].status, 'expired');
    assert.equal((await sql('SELECT status FROM orders WHERE id = $1', [oid]))[0].status, 'matching');
    await sql("UPDATE order_dispatches SET deadline_at = NOW() - interval '1 second' WHERE order_id = $1", [oid]);
    await h.tick();
    assert.equal((await sql('SELECT status FROM orders WHERE id = $1', [oid]))[0].status, 'cancelled');
    const notes = (await api('GET', '/api/customer/notifications', { token: cus.token })).body.items;
    assert.ok(notes.some((n) => n.title === 'Chưa tìm được thợ' && n.data.order_id === oid));

    // thợ tắt nhận đơn -> offer đang giữ được thu hồi (không tính là bỏ lỡ), đơn đi tiếp tới thợ khác
    const oid2 = await h.order(cus, C.SVC);
    assert.equal((await h.offer(a)).order_id, oid2);
    const rateBefore = (await sql('SELECT acceptance_rate FROM workers WHERE user_id = $1', [a.id]))[0].acceptance_rate;
    await api('PATCH', '/api/worker/availability', { token: a.token, body: { online: false } });
    assert.equal(await h.offer(a), null);
    await h.tick();
    assert.ok([(await h.offer(b))?.order_id, (await h.offer(c))?.order_id].includes(oid2));
    assert.equal((await sql('SELECT acceptance_rate FROM workers WHERE user_id = $1', [a.id]))[0].acceptance_rate, rateBefore);
    // khách huỷ (API app khách) -> offer còn lại đóng
    status(await api('POST', `/api/customer/orders/${oid2}/cancel`, { token: cus.token, body: { reason: 'Không cần nữa' } }), 200);
    await h.tick();
    assert.equal(await h.offer(b), null);
    assert.equal(await h.offer(c), null);
    assert.equal((await sql('SELECT COUNT(*)::int AS n FROM order_dispatches'))[0].n, 0);
  });

  test('thợ huỷ khi chưa tới: đơn quay lại hàng đợi cho thợ khác; huỷ khi đã tới: đơn huỷ luôn', async () => {
    await reset({ mode: 'instant', maxOffers: 1 });
    const w1 = await h.readyWorker(ADMIN, { name: 'Thợ Huỷ', at: off(-0.4, -0.4), trust: 0.9 });
    const w2 = await h.readyWorker(ADMIN, { name: 'Thợ Thay', at: off(-0.8, -0.4), trust: 0.6 });
    const cus = await h.customer('Khách', off(-0.4, -0.4));
    const oid = await h.order(cus, C.SVC);
    const a = await h.offer(w1);
    assert.ok(a);
    assert.equal(await h.offer(w2), null);
    await api('POST', `/api/worker/offers/${a.id}/accept`, { token: w1.token });
    await advance(w1, oid, 'on_the_way');
    const r = await api('POST', `/api/worker/orders/${oid}/cancel`, { token: w1.token, body: { reason: 'Xe bị hỏng giữa đường' } });
    status(r, 200);
    assert.equal(r.body.status, 'matching');
    assert.equal((await api('GET', '/api/worker/home', { token: w1.token })).body.availability, 'online');
    const b = await h.offer(w2);
    assert.ok(b && b.order_id === oid);
    assert.equal(await h.offer(w1), null);
    const c = (await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body;
    assert.deepEqual(c.history.map((x) => x.to_status), ['pending', 'matching', 'accepted', 'on_the_way', 'matching']);
    assert.equal((await api('GET', '/api/worker/performance', { token: w1.token })).body.jobs_cancelled_by_worker, 1);
    status(await api('GET', `/api/worker/orders/${oid}`, { token: w1.token }), 404); // không còn là đơn của thợ 1

    await api('POST', `/api/worker/offers/${b.id}/accept`, { token: w2.token });
    await advance(w2, oid, 'on_the_way');
    await advance(w2, oid, 'arrived');
    const r2 = await api('POST', `/api/worker/orders/${oid}/cancel`, { token: w2.token, body: { reason: 'Khách không có mặt' } });
    assert.equal(r2.body.status, 'cancelled');
    assert.equal((await api('GET', `/api/customer/orders/${oid}`, { token: cus.token })).body.cancel_reason, '[Thợ] Khách không có mặt');
    status(await advance(w2, oid, 'in_progress'), 400); // đơn đã huỷ: không đi tiếp được
    assert.equal((await api('GET', '/api/worker/home', { token: w2.token })).body.availability, 'online');
  });

  test('chế độ batch: Hungarian ghép tối ưu toàn cục, không gửi ngay', async () => {
    await reset({ mode: 'batch' });
    const w1 = await h.readyWorker(ADMIN, { name: 'Thợ Lô 1', at: off(5, 5), trust: 0.9 });
    const w2 = await h.readyWorker(ADMIN, { name: 'Thợ Lô 2', at: off(5, 7), trust: 0.9 });
    const cA = await h.customer('Khách A', off(5, 6.2));
    const cB = await h.customer('Khách B', off(5, 9.5));
    // Đơn A gần cả 2 thợ, đơn B chỉ gần thợ 2: tham lam theo thứ tự đến cho A lấy thợ 2 (gần hơn),
    // Hungarian phải ghép A-thợ1, B-thợ2 (tổng điểm cao hơn, ghép được cả 2 đơn).
    const oa = await h.order(cA, C.SVC);
    const ob = await h.order(cB, C.SVC);
    assert.equal(await h.offer(w1), null);
    assert.equal(await h.offer(w2), null);
    assert.equal((await api('GET', `/api/customer/orders/${oa}`, { token: cA.token })).body.matching_mode, 'batch');
    const res = await h.dispatch.runBatchRound();
    assert.equal(res.assigned, 2);
    assert.deepEqual(Object.fromEntries(res.pairs), { [oa]: w1.id, [ob]: w2.id });
    assert.equal((await h.offer(w1)).order_id, oa);
    assert.equal((await h.offer(w2)).order_id, ob);
    assert.equal((await h.offer(w1)).mode, 'batch');
    // thợ 1 từ chối -> lượt sau đơn A không còn ai (thợ 2 đang giữ offer B)
    await api('POST', `/api/worker/offers/${(await h.offer(w1)).id}/reject`, { token: w1.token, body: {} });
    assert.equal((await h.dispatch.runBatchRound()).assigned, 0);
  });

  test('chế độ auto: nhóm đơn tranh cùng thợ -> Hungarian, đơn đứng một mình -> Greedy top-k', async () => {
    await reset({ mode: 'auto', maxOffers: 2 });
    const w1 = await h.readyWorker(ADMIN, { name: 'Thợ Auto 1', at: off(-10, -10), trust: 0.9 });
    const w2 = await h.readyWorker(ADMIN, { name: 'Thợ Auto 2', at: off(-10, -8), trust: 0.9 });
    const w3 = await h.readyWorker(ADMIN, { name: 'Thợ Auto 3', at: off(-25, -25), trust: 0.8 });
    const w4 = await h.readyWorker(ADMIN, { name: 'Thợ Auto 4', at: off(-25, -24), trust: 0.7 });
    const cA = await h.customer('Khách A', off(-10, -8.8)); // gần cả thợ 1 và thợ 2
    const cB = await h.customer('Khách B', off(-10, -5.5)); // chỉ gần thợ 2 -> tranh thợ 2 với đơn A
    const cC = await h.customer('Khách C', off(-25, -24.5)); // khu khác, không tranh với ai
    const oa = await h.order(cA, C.SVC);
    const ob = await h.order(cB, C.SVC);
    const oc = await h.order(cC, C.SVC);
    for (const w of [w1, w2, w3, w4]) assert.equal(await h.offer(w), null); // chờ nhịp điều phối, không gửi ngay
    const res = await h.dispatch.runAutoRound();
    assert.equal(res.orders, 3);
    assert.equal(res.instant_orders, 1);
    assert.equal(res.batch_groups, 1);
    assert.equal(res.batch.assigned, 2);
    assert.deepEqual(Object.fromEntries(res.batch.pairs), { [oa]: w1.id, [ob]: w2.id });
    assert.equal((await h.offer(w1)).order_id, oa);
    assert.equal((await h.offer(w1)).mode, 'batch');
    assert.equal((await h.offer(w2)).order_id, ob);
    assert.equal((await h.offer(w3)).order_id, oc);
    assert.equal((await h.offer(w4)).order_id, oc);
    assert.equal((await h.offer(w3)).mode, 'instant');
    const mode = async (id, c) => (await api('GET', `/api/customer/orders/${id}`, { token: c.token })).body.matching_mode;
    assert.equal(await mode(oa, cA), 'batch'); // đơn ghi chế độ THỰC TẾ đã dùng
    assert.equal(await mode(oc, cC), 'instant');
  });

  test('đơn hẹn trước: chỉ đi trong 60 phút trước giờ hẹn, chặn trùng lịch, báo giá sau khi đến', async () => {
    await reset({ mode: 'instant', maxOffers: 2 });
    const w1 = await h.readyWorker(ADMIN, { name: 'Thợ Hẹn Một', at: off(-5, 5), trust: 0.9 });
    const w2 = await h.readyWorker(ADMIN, { name: 'Thợ Hẹn Hai', at: off(-5, 5.5), trust: 0.5 });
    const cus = await h.customer('Khách', off(-5, 5));
    const when = new Date(Date.now() + 2 * 86_400_000);
    when.setUTCHours(12, 0, 0, 0); // 19:00 giờ VN
    const oid = await h.order(cus, C.SVC, { scheduledAt: when.toISOString() });
    const a = await h.offer(w1);
    assert.ok(a && a.order_id === oid && a.scheduled_at);
    status(await api('POST', `/api/worker/offers/${a.id}/accept`, { token: w1.token }), 200);
    const home = (await api('GET', '/api/worker/home', { token: w1.token })).body;
    assert.equal(home.availability, 'online'); // lịch còn xa: vẫn nhận đơn khác
    assert.equal(home.upcoming[0].id, oid);

    let d = (await api('GET', `/api/worker/orders/${oid}`, { token: w1.token })).body;
    assert.equal(new Date(d.start_available_at).getTime(), when.getTime() - 3600_000);
    const early = await advance(w1, oid, 'on_the_way');
    status(early, 400);
    assert.match(early.body.message, /18:00/);
    assert.equal(d.can_quote, false);
    const q = await api('POST', `/api/worker/orders/${oid}/extra-quotes`, { token: w1.token, body: { description: 'Thay dây', amount: 50000 } });
    status(q, 400);
    assert.match(q.body.message, /đến nơi/);

    // đơn hẹn thứ 2 lệch 30 phút: thợ 1 đã có lịch trùng giờ -> chỉ thợ 2 được mời
    const oid2 = await h.order(cus, C.SVC, { scheduledAt: new Date(when.getTime() + 30 * 60_000).toISOString() });
    const b1 = await h.offer(w1);
    const b2 = await h.offer(w2);
    assert.ok(!b1 || b1.order_id !== oid2);
    assert.equal(b2.order_id, oid2);
    await api('POST', `/api/customer/orders/${oid2}/cancel`, { token: cus.token, body: { reason: 'Đổi lịch' } });

    // còn 30 phút -> được đi; đang đi vẫn chưa báo giá được; tới nơi thì được
    await sql("UPDATE orders SET scheduled_at = NOW() + interval '30 minutes' WHERE id = $1", [oid]);
    d = (await api('GET', `/api/worker/orders/${oid}`, { token: w1.token })).body;
    assert.equal(d.start_available_at, null);
    const go = await advance(w1, oid, 'on_the_way');
    status(go, 200);
    assert.equal(go.body.can_quote, false);
    const there = await advance(w1, oid, 'arrived');
    assert.equal(there.body.can_quote, true);
  });

  test('chỉ ghép thợ có kỹ năng đúng danh mục, trong bán kính nhận việc của thợ, vị trí còn mới', async () => {
    await reset({ mode: 'instant', maxOffers: 3 });
    const dien = await h.readyWorker(ADMIN, { name: 'Thợ Sửa Chữa', at: off(1, 0) });
    const tuDien = await h.readyWorker(ADMIN, { name: 'Thợ Tủ Điện', at: off(1, 0), categories: [C.CAT2] });
    const near = await h.readyWorker(ADMIN, { name: 'Thợ Bán Kính Nhỏ', at: off(4, 0) });
    await api('PATCH', '/api/worker/profile', { token: near.token, body: { service_radius_km: 2 } });
    const stale = await h.readyWorker(ADMIN, { name: 'Thợ Mất GPS', at: off(0.5, 0) });
    await sql("UPDATE workers SET location_updated_at = NOW() - interval '30 minutes' WHERE user_id = $1", [stale.id]);
    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);
    assert.equal((await h.offer(dien)).order_id, oid);
    assert.equal(await h.offer(tuDien), null);
    assert.equal(await h.offer(near), null);
    assert.equal(await h.offer(stale), null);
    const oid2 = await h.order(cus, C.SVC2);
    assert.equal((await h.offer(tuDien)).order_id, oid2);
  });

  test('thợ mới chưa có lịch sử: điểm tin cậy trung tính khi ghép (cold start), thợ đã có đơn thì giữ điểm thật', async () => {
    await reset({ mode: 'instant', maxOffers: 1 });
    const fresh = await h.readyWorker(ADMIN, { name: 'Thợ Mới', at: off(1, 0), trust: 0 });
    const low = await h.readyWorker(ADMIN, { name: 'Thợ Điểm Thấp', at: off(1, 0), trust: 0.3 });
    const veteran = await h.readyWorker(ADMIN, { name: 'Thợ Cũ Điểm 0', at: off(1, 0), trust: 0 });
    await sql('UPDATE workers SET total_jobs = 12 WHERE user_id = $1', [veteran.id]);

    const [lat, lng] = off();
    const list = await findCandidates({ lat, lng, categoryId: C.CAT, radiusKm: 10 });
    const by = Object.fromEntries(list.map((c) => [Number(c.id), c]));
    assert.equal(by[fresh.id].trust_score, settings.trustColdStart);
    assert.equal(by[fresh.id].trust_cold_start, true);
    assert.equal(by[low.id].trust_score, 0.3);
    assert.equal(by[veteran.id].trust_score, 0);
    assert.equal(by[veteran.id].trust_cold_start, false);

    // k = 1, cùng khoảng cách / kinh nghiệm: thợ mới (0.5) được mời trước thợ điểm thấp (0.3)
    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);
    assert.equal((await h.offer(fresh)).order_id, oid);
    assert.equal(await h.offer(low), null);
  });
});

// ═════════════════════════════════════════════════════════════════════════
describe('Realtime (Socket.IO) + admin', () => {
  test('thợ nhận offer:new tức thì, khách nhận worker:location khi thợ di chuyển', async () => {
    await reset({ mode: 'instant', maxOffers: 1 });
    const w = await h.readyWorker(ADMIN, { at: off(0.4, 0) });
    const cus = await h.customer();
    const connect = (token) =>
      new Promise((resolve, reject) => {
        const s = ioClient(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
        s.on('connect', () => resolve(s));
        s.on('connect_error', reject);
      });
    const ws = await connect(w.token);
    const cs = await connect(cus.token);
    try {
      const gotOffer = new Promise((r) => ws.once('offer:new', r));
      const oid = await h.order(cus, C.SVC);
      const ev = await gotOffer;
      assert.equal(ev.order_id, oid);
      const gotUpdate = new Promise((r) => cs.once('order:updated', r));
      await api('POST', `/api/worker/offers/${ev.offer_id}/accept`, { token: w.token });
      assert.equal((await gotUpdate).status, 'accepted');
      await advance(w, oid, 'on_the_way');
      const gotLoc = new Promise((r) => cs.once('worker:location', r));
      await api('PATCH', '/api/worker/location', { token: w.token, body: { latitude: 21.03, longitude: 105.85 } });
      const loc = await gotLoc;
      assert.equal(loc.order_id, oid);
      assert.equal(loc.lat, 21.03);
    } finally {
      ws.close();
      cs.close();
    }
  });

  test('khách huỷ khi đang tìm thợ -> app thợ gỡ lời mời ngay; admin huỷ đơn đã nhận -> thợ được báo, hết bận', async () => {
    await reset({ mode: 'instant', maxOffers: 1 });
    const w = await h.readyWorker(ADMIN, { at: off(0.4, 0) });
    const cus = await h.customer();
    const ws = await new Promise((resolve, reject) => {
      const s = ioClient(BASE, { auth: { token: w.token }, transports: ['websocket'], reconnection: false });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
    try {
      const oid = await h.order(cus, C.SVC);
      const live = await h.offer(w);
      assert.equal(live.order_id, oid);
      const closed = new Promise((r) => ws.once('offer:closed', r));
      status(await api('POST', `/api/customer/orders/${oid}/cancel`, { token: cus.token, body: { reason: 'Đặt nhầm' } }), 200);
      assert.equal((await closed).offer_id, live.id);
      assert.equal(await h.offer(w), null);
      // lời mời bị đóng vì khách huỷ không bị tính là thợ bỏ lỡ
      const [f] = await sql('SELECT status, reason FROM order_offers WHERE id = $1', [live.id]);
      assert.deepEqual([f.status, f.reason], ['expired', 'closed']);

      const oid2 = await h.order(cus, C.SVC);
      status(await api('POST', `/api/worker/offers/${(await h.offer(w)).id}/accept`, { token: w.token }), 200);
      await advance(w, oid2, 'on_the_way');
      const [busy] = await sql('SELECT is_busy FROM workers WHERE user_id = $1', [w.id]);
      assert.equal(busy.is_busy, true);
      const updated = new Promise((r) => ws.once('order:updated', r));
      status(await api('POST', `/api/admin/orders/${oid2}/cancel`, { cookie: ADMIN, body: { reason: 'Khách báo không cần nữa' } }), 200);
      assert.equal((await updated).status, 'cancelled');
      const [free] = await sql('SELECT is_busy FROM workers WHERE user_id = $1', [w.id]);
      assert.equal(free.is_busy, false);
      const notes = await api('GET', '/api/worker/notifications', { token: w.token });
      assert.equal(notes.body.items[0].title, 'Đơn đã bị huỷ');
      assert.equal(notes.body.items[0].data.order_id, oid2);
    } finally {
      ws.close();
    }
  });

  test('admin: xem trạng thái điều phối, đổi chế độ ghép, form cấu hình nhận mode/max_offers, duyệt / từ chối lệnh rút', async () => {
    await reset();
    const st = await api('GET', '/api/admin/dispatch/status', { cookie: ADMIN });
    status(st, 200);
    assert.equal(st.body.config.mode, 'instant');
    status(await api('PUT', '/api/admin/dispatch/mode', { cookie: ADMIN, body: { mode: 'hungarian' } }), 400);
    const m = await api('PUT', '/api/admin/dispatch/mode', { cookie: ADMIN, body: { mode: 'auto', max_offers: 4 } });
    status(m, 200);
    assert.equal(m.body.config.mode, 'auto');
    assert.equal(m.body.config.max_offers, 4);
    status(await api('PUT', '/api/admin/dispatch/mode', { cookie: ADMIN }), 400);
    status(await api('GET', '/api/admin/dispatch/status'), 401);

    // API cấu hình của web quản trị: không gửi mode thì giữ nguyên (form cũ vẫn chạy), gửi thì lưu
    const base = { name: 'Thử', w_distance: 0.35, w_trust: 0.3, w_skill: 0.15, w_acceptance: 0.1, w_workload: 0.1, max_radius_km: 8, offer_timeout_seconds: 45, batch_window_seconds: 15 };
    status(await api('POST', '/api/admin/matching-configs', { cookie: ADMIN, body: base }), 201);
    status(await api('POST', '/api/admin/matching-configs', { cookie: ADMIN, body: { ...base, name: 'Lô', mode: 'batch', max_offers: 1 } }), 201);
    const list = (await api('GET', '/api/admin/matching-configs', { cookie: ADMIN })).body.items;
    assert.equal(list.find((x) => x.name === 'Thử').mode, 'auto');
    assert.equal(list.find((x) => x.name === 'Lô').mode, 'batch');
    status(await api('POST', '/api/admin/matching-configs', { cookie: ADMIN, body: { ...base, name: 'Sai', mode: 'x' } }), 400);

    // tắt duyệt tự động: lệnh rút chờ admin; từ chối thì hoàn tiền vào ví
    settings.withdrawalAutoApprove = false;
    try {
      const w = await h.registerWorker();
      await api('PUT', '/api/worker/bank-account', { token: w.token, body: { bank_name: 'ACB', account_number: '123456789', account_holder: 'Nguyen Van A' } });
      await api('POST', '/api/worker/wallet/topup', { token: w.token, body: { amount: 400000 } });
      const r1 = await api('POST', '/api/worker/wallet/withdrawals', { token: w.token, body: { amount: 100000 } });
      const r2 = await api('POST', '/api/worker/wallet/withdrawals', { token: w.token, body: { amount: 150000 } });
      assert.equal(r1.body.status, 'pending');
      assert.equal((await api('GET', '/api/worker/wallet', { token: w.token })).body.pending_withdrawal, 250000);
      const pending = (await api('GET', '/api/admin/withdrawals?status=pending', { cookie: ADMIN })).body;
      assert.equal(pending.total, 2);
      status(await api('POST', `/api/admin/withdrawals/${r1.body.id}/approve`, { cookie: ADMIN, body: {} }), 200);
      status(await api('POST', `/api/admin/withdrawals/${r2.body.id}/reject`, { cookie: ADMIN, body: {} }), 400); // cần lý do
      status(await api('POST', `/api/admin/withdrawals/${r2.body.id}/reject`, { cookie: ADMIN, body: { note: 'Sai tên chủ tài khoản' } }), 200);
      status(await api('POST', `/api/admin/withdrawals/${r2.body.id}/approve`, { cookie: ADMIN, body: {} }), 400);
      const wallet = (await api('GET', '/api/worker/wallet', { token: w.token })).body;
      assert.equal(wallet.balance, 400000 - 100000);
      assert.equal(wallet.recent[0].type, 'refund');
    } finally {
      settings.withdrawalAutoApprove = true;
    }
  });
});
