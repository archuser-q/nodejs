import { pool } from './src/config/db.js';

const { rows } = await pool.query('SELECT NOW(), current_database()');
console.log(rows[0]);
await pool.end();