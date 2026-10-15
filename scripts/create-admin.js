import bcrypt from 'bcryptjs';
import { pool } from '../src/config/db.js';

const [email, password, fullName = 'Quản trị viên'] = process.argv.slice(2);
if (!email || !password) {
  console.log('Cách dùng: npm run create-admin -- <email> <mật khẩu> [họ tên]');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 10);
const { rows } = await pool.query(
  `INSERT INTO users (email, password_hash, full_name, role)
   VALUES ($1, $2, $3, 'admin')
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
   RETURNING id, email`,
  [email, hash, fullName],
);
console.log('Đã tạo admin:', rows[0]);
await pool.end();