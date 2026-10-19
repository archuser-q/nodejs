/** Tạo lại CSDL test từ đầu bằng đúng các migration của dự án: node test/setup-db.js */
import './env.js';
import { execFileSync } from 'child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await client.end();

execFileSync('npx', ['node-pg-migrate', 'up', '-m', 'migrations', '-j', 'sql', '--no-check-order', '--no-verbose'], {
  env: { ...process.env, DATABASE_URL: url },
  stdio: ['ignore', 'ignore', 'inherit'],
});
console.log('[test] CSDL test đã sẵn sàng:', url.replace(/:[^:@/]+@/, ':***@'));
