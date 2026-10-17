// [DEV-TOOLS] Nạp dữ liệu mẫu để test App Khách hàng: npm run seed:dev
import { readFile } from 'fs/promises';
import { pool } from '../src/config/db.js';

const sqlText = await readFile(new URL('./seed_dev.sql', import.meta.url), 'utf8');
await pool.query(sqlText);
const { rows } = await pool.query(
  `SELECT (SELECT COUNT(*) FROM services)::int AS services,
          (SELECT COUNT(*) FROM workers WHERE verification_status = 'approved')::int AS workers`,
);
console.log('Đã nạp dữ liệu mẫu:', rows[0], '· khách demo 0912345678 / 123456');
await pool.end();
