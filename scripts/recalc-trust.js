/**
 * Tính lại điểm tin cậy (Trust Score) cho mọi thợ đã có lịch sử, VD sau khi đổi tham số công thức
 * ở src/algorithms/trust.js.   npm run trust:recalc   (Docker: docker compose exec api npm run trust:recalc)
 */
import { pool } from '../src/config/db.js';
import { recalcAllTrustScores } from '../src/services/trust/trust.service.js';

const r = await recalcAllTrustScores(pool, 'recalc');
console.log(`[trust:recalc] Đã tính lại ${r.updated}/${r.workers} thợ (thợ chưa có lịch sử giữ nguyên, ghép dùng mức 0,5)`);
await pool.end();
