/**
 * Lệnh khởi động container API (Docker): migration -> (tuỳ chọn) seed demo -> chạy server.  [Thành viên B]
 * Viết bằng Node thay cho shell script để không lỗi xuống dòng CRLF khi clone repo trên Windows.
 */
import { spawnSync } from 'child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;

async function waitForDb() {
  for (let i = 1; i <= 30; i++) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.end();
      return;
    } catch {
      console.log(`[start] chờ CSDL... (${i})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Không kết nối được CSDL');
}

const run = (args) => {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

await waitForDb();
console.log('[start] chạy migration');
run(['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '-m', 'migrations', '-j', 'sql', '--no-check-order', '--no-verbose']);
if ((process.env.SEED_DEMO ?? 'true') === 'true') {
  console.log('[start] nạp dữ liệu demo (chạy lại không tạo trùng)');
  run(['scripts/seed-demo.js']);
}
await import('../src/server.js');
