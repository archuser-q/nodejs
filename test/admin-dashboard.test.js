/**
 * Kiểm thử API web quản trị bổ sung khi ghép với app thợ:
 * duyệt từng giấy tờ, hàng chờ duyệt theo submitted_at, khiếu nại do thợ báo cáo,
 * bản đồ giám sát, việc cần xử lý, thông báo của admin, chi tiết đơn (ảnh, lời mời, vết di chuyển).
 */
import './env.js';
import { after, before, beforeEach, describe, test } from 'node:test';
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

/** Thợ đã nộp đủ giấy tờ và bấm gửi hồ sơ (chưa duyệt) */
async function submittedWorker(name) {
  const w = await h.registerWorker(name);
  const t = w.token;
  await api('PATCH', '/api/worker/profile', { token: t, body: { phone: h.phone() } });
  await api('PUT', '/api/worker/skills', { token: t, body: { skills: [{ category_id: C.CAT, years: 3 }] } });
  for (const type of ['id_card_front', 'id_card_back', 'portrait']) {
    status(await api('POST', '/api/worker/documents', { token: t, body: { doc_type: type, file_url: await h.upload(t) } }), 201);
  }
  status(await api('POST', '/api/worker/verification/submit', { token: t }), 200);
  return w;
}

describe('Web quản trị: duyệt hồ sơ thợ theo từng giấy tờ', () => {
  beforeEach(async () => {
    C = await h.reset();
    ADMIN = await h.adminCookie();
  });

  test('hàng chờ duyệt xếp theo thời gian gửi; thợ đang điền dở không lọt vào hàng chờ', async () => {
    const draft = await h.registerWorker('Thợ Điền Dở');
    const a = await submittedWorker('Thợ Gửi Trước');
    const b = await submittedWorker('Thợ Gửi Sau');
    await sql("UPDATE workers SET submitted_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1", [a.id]);

    const list = (await api('GET', '/api/admin/workers?review=needed', { cookie: ADMIN })).body;
    assert.deepEqual(list.items.map((x) => Number(x.id)), [a.id, b.id]);
    assert.ok(list.items[0].submitted_at);
    assert.equal(list.items[0].pending_docs, 3);
    assert.ok(!list.items.some((x) => Number(x.id) === draft.id));
    assert.equal((await api('GET', '/api/admin/dashboard/pending', { cookie: ADMIN })).body.workers_to_review, 2);
  });

  test('từ chối 1 giấy: chỉ giấy đó bị từ chối, thợ thấy lý do đúng giấy, tải lại đúng giấy đó rồi được duyệt', async () => {
    const w = await submittedWorker('Thợ Duyệt Lẻ');
    const detail = (await api('GET', `/api/admin/workers/${w.id}`, { cookie: ADMIN })).body;
    assert.ok(detail.worker.submitted_at);
    const back = detail.documents.find((d) => d.doc_type === 'id_card_back');
    assert.equal(back.is_current, true);

    status(await api('PATCH', `/api/admin/workers/${w.id}/documents/${back.id}`, { cookie: ADMIN, body: { status: 'rejected' } }), 400); // cần lý do
    const rj = await api('PATCH', `/api/admin/workers/${w.id}/documents/${back.id}`, { cookie: ADMIN, body: { status: 'rejected', reject_reason: 'Ảnh bị loá' } });
    status(rj, 200);
    assert.equal(rj.body.document.status, 'rejected');

    // duyệt cả hồ sơ khi còn thiếu giấy hợp lệ -> báo thiếu đúng giấy
    const fail = await api('PATCH', `/api/admin/workers/${w.id}/verification`, { cookie: ADMIN, body: { status: 'approved' } });
    status(fail, 400);
    assert.match(fail.body.message, /CCCD mặt sau/);

    status(await api('PATCH', `/api/admin/workers/${w.id}/verification`, { cookie: ADMIN, body: { status: 'rejected', note: 'CCCD mặt sau: Ảnh bị loá' } }), 200);
    const docs = await sql('SELECT doc_type, status FROM worker_documents WHERE worker_id = $1 ORDER BY id', [w.id]);
    assert.deepEqual(docs.map((d) => d.status), ['pending', 'rejected', 'pending']); // giấy hợp lệ vẫn giữ nguyên

    let me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.deepEqual(me.onboarding.missing, ['Tải lại CCCD mặt sau']);
    assert.ok(me.onboarding.reject_reasons.some((r) => r === 'CCCD mặt sau: Ảnh bị loá'));

    status(await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: 'id_card_back', file_url: await h.upload(w.token) } }), 201);
    status(await api('POST', '/api/worker/verification/submit', { token: w.token }), 200);
    status(await api('PATCH', `/api/admin/workers/${w.id}/verification`, { cookie: ADMIN, body: { status: 'approved' } }), 200);
    me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.equal(me.profile.verification_status, 'approved');
    // giấy bị từ chối trước đó KHÔNG bị chuyển thành đã duyệt
    const after = await sql("SELECT status FROM worker_documents WHERE worker_id = $1 AND doc_type = 'id_card_back' ORDER BY id", [w.id]);
    assert.deepEqual(after.map((d) => d.status), ['rejected', 'approved']);
  });

  test('thợ đã duyệt gửi CCCD mới: vào hàng chờ, admin từ chối bản mới thì thợ được báo ngay, bản cũ vẫn hiệu lực', async () => {
    const w = await h.readyWorker(ADMIN, { name: 'Thợ Đổi CCCD' });
    status(await api('POST', '/api/worker/documents', { token: w.token, body: { doc_type: 'id_card_front', file_url: await h.upload(w.token) } }), 201);
    const list = (await api('GET', '/api/admin/workers?review=needed', { cookie: ADMIN })).body;
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].pending_docs, 1);

    const detail = (await api('GET', `/api/admin/workers/${w.id}`, { cookie: ADMIN })).body;
    const fronts = detail.documents.filter((d) => d.doc_type === 'id_card_front');
    assert.equal(fronts.length, 2);
    const fresh = fronts.find((d) => d.is_current);
    const old = fronts.find((d) => !d.is_current);
    assert.equal(fresh.status, 'pending');

    // không cho từ chối bản hợp lệ duy nhất của giấy bắt buộc khi thợ đang hoạt động
    status(await api('PATCH', `/api/admin/workers/${w.id}/documents/${old.id}`, { cookie: ADMIN, body: { status: 'rejected', reject_reason: 'x' } }), 400);

    status(await api('PATCH', `/api/admin/workers/${w.id}/documents/${fresh.id}`, { cookie: ADMIN, body: { status: 'rejected', reject_reason: 'Không khớp ảnh chân dung' } }), 200);
    const n = (await api('GET', '/api/worker/notifications', { token: w.token })).body.items[0];
    assert.equal(n.type, 'verification');
    assert.equal(n.title, 'CCCD mặt trước chưa được duyệt');
    assert.equal(n.body, 'Không khớp ảnh chân dung');
    const me = (await api('GET', '/api/worker/me', { token: w.token })).body;
    assert.equal(me.profile.verification_status, 'approved'); // vẫn nhận việc bằng CCCD cũ
    assert.equal((await api('GET', '/api/admin/workers?review=needed', { cookie: ADMIN })).body.items.length, 0);
  });
});

describe('Web quản trị: khiếu nại, bản đồ, thông báo, chi tiết đơn', () => {
  beforeEach(async () => {
    C = await h.reset({ mode: 'instant', maxOffers: 1 });
    ADMIN = await h.adminCookie();
  });

  test('phân biệt báo cáo của thợ với khiếu nại của khách; xử lý xong thì báo đúng người gửi', async () => {
    const w = await h.readyWorker(ADMIN, { name: 'Thợ Báo Cáo', at: off(0.3, 0) });
    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);
    await h.tick();
    const of = await h.offer(w);
    status(await api('POST', `/api/worker/offers/${of.id}/accept`, { token: w.token }), 200);
    status(await api('POST', `/api/worker/orders/${oid}/report`, { token: w.token, body: { reason: 'Khách không nghe máy' } }), 201);

    const all = (await api('GET', '/api/admin/complaints?source=worker', { cookie: ADMIN })).body;
    assert.equal(all.items.length, 1);
    assert.equal(all.items[0].source, 'worker');
    assert.equal((await api('GET', '/api/admin/complaints?source=customer', { cookie: ADMIN })).body.items.length, 0);
    status(await api('GET', '/api/admin/complaints?source=abc', { cookie: ADMIN }), 400);
    const d = (await api('GET', `/api/admin/complaints/${all.items[0].id}`, { cookie: ADMIN })).body;
    assert.equal(d.reporter_name, 'Thợ Báo Cáo');
    assert.equal((await api('GET', '/api/admin/dashboard/pending', { cookie: ADMIN })).body.reports_open, 1);

    status(await api('PATCH', `/api/admin/complaints/${d.id}`, { cookie: ADMIN, body: { status: 'resolved', resolution: 'Đã gọi cho khách' } }), 200);
    const n = (await api('GET', '/api/worker/notifications', { token: w.token })).body.items[0];
    assert.equal(n.type, 'complaint');
    assert.match(n.title, /Khách không nghe máy/);
    assert.equal(n.data.order_id, oid);
    const rep = (await api('GET', '/api/worker/reports', { token: w.token })).body.items[0];
    assert.equal(rep.status, 'resolved');
  });

  test('bản đồ giám sát: đơn đang chạy + thợ có vị trí; chi tiết đơn có lời mời, ảnh, vết di chuyển', async () => {
    const w = await h.readyWorker(ADMIN, { name: 'Thợ Bản Đồ', at: off(0.5, 0) });
    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);

    let map = (await api('GET', '/api/admin/monitor/map', { cookie: ADMIN })).body;
    assert.equal(map.orders.length, 1);
    assert.equal(map.orders[0].status, 'matching');
    assert.ok(Math.abs(map.orders[0].lat - off()[0]) < 1e-6);
    assert.equal(map.workers.length, 1);
    assert.equal(map.workers[0].is_online, true);
    assert.equal(map.workers[0].location_fresh, true);

    await h.tick();
    map = (await api('GET', '/api/admin/monitor/map', { cookie: ADMIN })).body;
    assert.equal(map.orders[0].live_offers, 1);
    const of = await h.offer(w);
    status(await api('POST', `/api/worker/offers/${of.id}/accept`, { token: w.token }), 200);
    status(await api('POST', `/api/worker/orders/${oid}/status`, { token: w.token, body: { status: 'on_the_way' } }), 200);
    const [lat, lng] = off(0.2, 0);
    status(await api('PATCH', '/api/worker/location', { token: w.token, body: { latitude: lat, longitude: lng } }), 200);

    map = (await api('GET', '/api/admin/monitor/map', { cookie: ADMIN })).body;
    assert.equal(map.orders[0].worker_name, 'Thợ Bản Đồ');
    assert.equal(map.workers[0].is_busy, true);
    assert.equal(map.workers[0].current_order_code, map.orders[0].code);

    const det = (await api('GET', `/api/admin/orders/${oid}`, { cookie: ADMIN })).body;
    assert.equal(det.offers.length, 1);
    assert.equal(det.offers[0].status, 'accepted');
    assert.equal(det.offers[0].worker_name, 'Thợ Bản Đồ');
    assert.ok(det.trail.length >= 1);
    assert.ok(Array.isArray(det.photos));

    status(await api('GET', '/api/admin/monitor/map'), 401);
  });

  test('thông báo của admin: hồ sơ thợ chờ duyệt, đánh dấu đã đọc', async () => {
    await submittedWorker('Thợ Mới Gửi');
    const list = (await api('GET', '/api/admin/notifications', { cookie: ADMIN })).body;
    assert.equal(list.unread, 1);
    assert.equal(list.items[0].type, 'worker_verification');
    status(await api('PATCH', `/api/admin/notifications/${list.items[0].id}/read`, { cookie: ADMIN }), 200);
    assert.equal((await api('GET', '/api/admin/notifications', { cookie: ADMIN })).body.unread, 0);
    status(await api('PATCH', '/api/admin/notifications/read-all', { cookie: ADMIN }), 200);
  });
});

describe('Web quản trị: đơn & đánh giá của thợ, tài chính', () => {
  beforeEach(async () => {
    C = await h.reset({ mode: 'instant', maxOffers: 1 });
    ADMIN = await h.adminCookie();
  });

  test('hồ sơ thợ: đơn đang làm / đã xong, toàn bộ đánh giá có phân trang + phân bố sao', async () => {
    const w = await h.readyWorker(ADMIN, { name: 'Thợ Hồ Sơ', at: off(0.3, 0) });
    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);
    await h.tick();
    status(await api('POST', `/api/worker/offers/${(await h.offer(w)).id}/accept`, { token: w.token }), 200);

    // 3 đơn đã hoàn thành có đánh giá 5, 4, 5 sao (dữ liệu dựng thẳng trong CSDL)
    for (const [i, stars] of [5, 4, 5].entries()) {
      const [o] = await sql(
        `INSERT INTO orders (code, customer_id, worker_id, service_id, address_text, location, status, matching_mode,
                             estimated_price, final_price, completed_at)
         VALUES ($1, $2, $3, $4, 'x', ST_SetSRID(ST_MakePoint(105.85, 21.03), 4326)::geography, 'completed', 'instant',
                 200000, 200000, NOW() - make_interval(hours => $5)) RETURNING id`,
        [`TNTEST${i}`, cus.id, w.id, C.SVC, i + 1],
      );
      await sql('INSERT INTO reviews (order_id, customer_id, worker_id, rating, comment) VALUES ($1, $2, $3, $4, $5)', [o.id, cus.id, w.id, stars, `Đánh giá ${i}`]);
    }

    const active = (await api('GET', `/api/admin/workers/${w.id}/orders?group=active`, { cookie: ADMIN })).body;
    assert.equal(active.items.length, 1);
    assert.equal(Number(active.items[0].id), oid);
    assert.deepEqual(active.counts, { active: 1, completed: 3, cancelled: 0 });
    const done = (await api('GET', `/api/admin/workers/${w.id}/orders?group=completed&pageSize=2`, { cookie: ADMIN })).body;
    assert.equal(done.total, 3);
    assert.equal(done.items.length, 2);
    assert.equal(done.items[0].code, 'TNTEST0'); // hoàn thành gần nhất lên đầu
    assert.equal(done.items[0].rating, 5);
    status(await api('GET', `/api/admin/workers/${w.id}/orders?group=abc`, { cookie: ADMIN }), 400);

    const rv = (await api('GET', `/api/admin/workers/${w.id}/reviews?pageSize=2`, { cookie: ADMIN })).body;
    assert.equal(rv.total, 3);
    assert.equal(rv.items.length, 2);
    assert.deepEqual(rv.summary.distribution, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 });
    assert.equal(rv.summary.average, 4.67);
    const five = (await api('GET', `/api/admin/workers/${w.id}/reviews?rating=5`, { cookie: ADMIN })).body;
    assert.equal(five.total, 2);
    status(await api('GET', `/api/admin/workers/${w.id}/reviews?rating=9`, { cookie: ADMIN }), 400);
  });

  test('tài chính: giao dịch ví thợ lọc theo thợ / loại, thanh toán của khách lọc theo phương thức', async () => {
    const w1 = await h.readyWorker(ADMIN, { name: 'Thợ Ví Một' });
    const w2 = await h.readyWorker(ADMIN, { name: 'Thợ Ví Hai' });
    await sql(
      `INSERT INTO worker_transactions (worker_id, type, amount, balance_after, note) VALUES
         ($1, 'topup', 200000, 200000, 'Nạp'), ($1, 'withdraw', -100000, 100000, 'Rút'), ($2, 'topup', 50000, 50000, 'Nạp')`,
      [w1.id, w2.id],
    );
    const all = (await api('GET', '/api/admin/finance/transactions', { cookie: ADMIN })).body;
    assert.equal(all.total, 3);
    const mine = (await api('GET', `/api/admin/finance/transactions?workerId=${w1.id}`, { cookie: ADMIN })).body;
    assert.equal(mine.total, 2);
    const tops = (await api('GET', '/api/admin/finance/transactions?type=topup', { cookie: ADMIN })).body;
    assert.equal(tops.total, 2);
    assert.equal(tops.summary.find((s) => s.type === 'topup').amount, 250000);
    assert.equal((await api('GET', '/api/admin/finance/transactions?search=Ví Hai', { cookie: ADMIN })).body.total, 1);
    status(await api('GET', '/api/admin/finance/transactions?type=abc', { cookie: ADMIN }), 400);
    status(await api('GET', '/api/admin/finance/transactions?from=2026-13-01', { cookie: ADMIN }), 400);

    const cus = await h.customer();
    const oid = await h.order(cus, C.SVC);
    await sql("INSERT INTO payments (order_id, method, amount, status, paid_at) VALUES ($1, 'momo', 250000, 'success', NOW()), ($1, 'cash', 250000, 'failed', NULL)", [oid]);
    const pay = (await api('GET', '/api/admin/finance/payments?method=momo', { cookie: ADMIN })).body;
    assert.equal(pay.total, 1);
    assert.equal(pay.items[0].customer_name, 'Nguyễn Thị Hoa');
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // ngày theo giờ VN
    assert.equal((await api('GET', `/api/admin/finance/payments?from=${today}&to=${today}`, { cookie: ADMIN })).body.total, 2);
    assert.equal((await api('GET', '/api/admin/finance/payments?status=success', { cookie: ADMIN })).body.summary[0].amount, 250000);
    status(await api('GET', '/api/admin/finance/payments'), 401);
  });
});
