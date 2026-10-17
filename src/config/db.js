import pg from 'pg'
import {env} from './env.js'

export const pool = new pg.Pool({
    connectionString: env.databaseUrl,
})

export const query = (text, params) => pool.query(text, params)

// Bộ đọc kiểu cho API app di động: BIGINT (20) và NUMERIC (1700) trả về number thay vì chuỗi.
// Chỉ dùng qua hàm sql() bên dưới nên không ảnh hưởng các API dashboard hiện có.
const NUMERIC_OIDS = new Set([20, 1700]);
const numberTypes = {
    getTypeParser: (oid, format) =>
        NUMERIC_OIDS.has(oid) ? (v) => (v === null ? null : Number(v)) : pg.types.getTypeParser(oid, format),
}

/** sql(db, text, params) — db là pool hoặc client trong transaction */
export const sql = (db, text, params) => db.query({ text, values: params, types: numberTypes })

/** q(text, params) — chạy trên pool */
export const q = (text, params) => sql(pool, text, params)
