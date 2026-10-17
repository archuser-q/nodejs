/**
 * [DEV-TOOLS] Giả lập thao tác của THỢ để test App Khách hàng khi chưa có app thợ.
 * Server phải đang chạy (npm run dev) với NODE_ENV khác production.
 *
 *   npm run simulate -- <mã đơn hoặc id> <lệnh> [tham số]
 *
 * Lệnh:
 *   accept [workerId]          thợ nhận đơn (bỏ trống = thợ xếp hạng cao nhất trong các đề xuất)
 *   on_the_way                 thợ bắt đầu đi
 *   move [lat lng]             thợ đi thêm 40% quãng đường (hoặc tới toạ độ cho trước)
 *   arrived                    thợ đã đến
 *   in_progress                bắt đầu sửa
 *   quote <số tiền> <mô tả>    báo giá phát sinh
 *   msg <nội dung>             thợ nhắn tin cho khách
 *   completed                  hoàn thành
 *   confirm-cash               thợ xác nhận đã thu tiền mặt
 *   auto                       chạy liền: accept → on_the_way → move x3 → arrived → in_progress
 *
 * VD: npm run simulate -- TN261017000001 accept
 */
import 'dotenv/config';

const BASE = `http://localhost:${process.env.PORT || 3000}/api/dev`;
const [order, cmd, ...args] = process.argv.slice(2);

if (!order || !cmd) {
  console.log('Cách dùng: npm run simulate -- <mã đơn|id> <accept|on_the_way|move|arrived|in_progress|quote|msg|completed|confirm-cash|auto> [tham số]');
  process.exit(1);
}

const call = async (path, body = {}) => {
  const res = await fetch(`${BASE}/orders/${encodeURIComponent(order)}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  console.log(`✔ ${path}`, json);
  return json;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS_CMDS = ['on_the_way', 'arrived', 'in_progress', 'completed'];

try {
  if (cmd === 'accept') await call('accept', args[0] ? { worker_id: Number(args[0]) } : {});
  else if (STATUS_CMDS.includes(cmd)) await call('status', { status: cmd });
  else if (cmd === 'move') await call('move', args.length >= 2 ? { lat: Number(args[0]), lng: Number(args[1]) } : {});
  else if (cmd === 'quote') await call('quote', { amount: Number(args[0]), description: args.slice(1).join(' ') });
  else if (cmd === 'msg') await call('message', { content: args.join(' ') });
  else if (cmd === 'confirm-cash') await call('confirm-cash');
  else if (cmd === 'auto') {
    await call('accept');
    await sleep(2000);
    await call('status', { status: 'on_the_way' });
    for (let i = 0; i < 3; i += 1) {
      await sleep(2500);
      await call('move');
    }
    await sleep(2000);
    await call('status', { status: 'arrived' });
    await sleep(2000);
    await call('status', { status: 'in_progress' });
  } else {
    throw new Error(`Lệnh không hợp lệ: ${cmd}`);
  }
} catch (err) {
  console.error('✘', err.message);
  process.exit(1);
}
