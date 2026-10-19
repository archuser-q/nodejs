import { pool } from '../config/db.js';

/**
 * Chạy fn(db, after) trong 1 transaction.
 *  - db: client của transaction (dùng với sql(db, ...))
 *  - after(cb): đăng ký việc làm SAU KHI COMMIT thành công (gửi thông báo, đẩy socket...).
 *    Lỗi trong transaction => ROLLBACK và các việc "after" bị bỏ, nên không báo nhầm cho người dùng.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  const effects = [];
  let result;
  try {
    await client.query('BEGIN');
    result = await fn(client, (cb) => effects.push(cb));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const cb of effects) {
    try {
      await cb();
    } catch (err) {
      console.error('[after-commit]', err);
    }
  }
  return result;
}
