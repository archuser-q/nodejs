-- Up Migration
-- =====================================================================
-- [Thành viên B] Bổ sung CSDL cho App Thợ + module ghép cặp (matching).
-- Chỉ THÊM bảng / cột / giá trị enum, không đổi ý nghĩa cột có sẵn của nhóm,
-- nên API admin và app khách hiện có chạy y như cũ.
-- =====================================================================

-- 1. Giá trị enum mới (PostgreSQL >= 12 cho phép ADD VALUE trong transaction,
--    chỉ không được dùng giá trị mới ngay trong cùng migration — ở đây không dùng)
ALTER TYPE offer_status ADD VALUE IF NOT EXISTS 'cancelled';   -- thợ đã nhận rồi huỷ (tính tỷ lệ huỷ)
ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'cancelled';   -- thợ rút lại báo giá khách chưa trả lời
ALTER TYPE wallet_txn_type ADD VALUE IF NOT EXISTS 'topup';    -- thợ nạp tiền vào ví (bù hoa hồng đơn tiền mặt)

-- 2. Hồ sơ thợ: lúc thợ bấm "Gửi hồ sơ xét duyệt" (NULL = đang điền dở, admin chưa cần duyệt)
ALTER TABLE workers ADD COLUMN submitted_at TIMESTAMPTZ;

-- 3. Tài khoản ngân hàng nhận tiền rút (mô phỏng)
CREATE TABLE worker_bank_accounts (
    worker_id BIGINT PRIMARY KEY REFERENCES workers(user_id) ON DELETE CASCADE,
    bank_name VARCHAR(100) NOT NULL,
    account_number VARCHAR(30) NOT NULL,
    account_holder VARCHAR(150) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Mã đặt lại mật khẩu qua email (lưu bản băm, không lưu mã gốc)
CREATE TABLE password_reset_codes (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash VARCHAR(255) NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_password_reset_user ON password_reset_codes(user_id, created_at DESC);

-- 5. Thực hiện đơn: xác nhận kiểm tra an toàn điện + ảnh trước/sau khi sửa (bằng chứng)
ALTER TABLE orders ADD COLUMN safety_checked_at TIMESTAMPTZ;

CREATE TABLE order_photos (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    uploader_id BIGINT NOT NULL REFERENCES users(id),
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('before', 'after')),
    url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_photos_order ON order_photos(order_id);

-- 6. Lời mời nhận đơn: đợt gửi + lý do (thợ từ chối / huỷ, hoặc 'closed' = đơn đã có thợ khác nhận / bị huỷ)
ALTER TABLE order_offers ADD COLUMN round SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE order_offers ADD COLUMN reason TEXT;
CREATE INDEX idx_offers_live ON order_offers(status, expires_at);

-- 7. Hàng đợi của bộ điều phối: mỗi đơn đang tìm thợ có 1 dòng
CREATE TABLE order_dispatches (
    order_id BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('instant', 'batch', 'auto')),  -- chế độ của cấu hình lúc vào hàng đợi
    rounds INT NOT NULL DEFAULT 0,            -- số đợt đã gửi offer
    offers_sent INT NOT NULL DEFAULT 0,
    last_candidates INT,                      -- số ứng viên hợp lệ ở lần ghép gần nhất
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ NOT NULL,         -- quá hạn mà chưa có thợ nhận thì hệ thống huỷ đơn
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_dispatches_next ON order_dispatches(next_attempt_at);

-- 8. Cấu hình ghép cặp: chế độ do HỆ THỐNG chọn (admin đặt), không phải khách chọn
--    instant = Greedy top-k theo đợt, batch = Hungarian theo cửa sổ lô,
--    auto = mỗi nhịp tự chọn 1 trong 2 cho từng nhóm đơn tranh chấp thợ (mặc định)
ALTER TABLE matching_configs ADD COLUMN mode VARCHAR(10) NOT NULL DEFAULT 'auto'
    CHECK (mode IN ('instant', 'batch', 'auto'));
ALTER TABLE matching_configs ADD COLUMN max_offers SMALLINT NOT NULL DEFAULT 1
    CHECK (max_offers BETWEEN 1 AND 10);      -- k: số thợ nhận offer cùng lúc mỗi đợt (mặc định 1, xem docs/MATCHING.md)

-- 9. Ví thợ: mỗi đơn chỉ ghi 1 lần thu nhập / hoa hồng (chống cộng trùng), liên kết lệnh rút
ALTER TABLE worker_transactions ADD COLUMN withdrawal_id BIGINT;
CREATE UNIQUE INDEX uq_worker_txn_order_type ON worker_transactions(order_id, type) WHERE order_id IS NOT NULL;

CREATE TABLE worker_withdrawals (
    id BIGSERIAL PRIMARY KEY,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
    amount NUMERIC(14, 0) NOT NULL CHECK (amount > 0),
    bank_name VARCHAR(100) NOT NULL,
    account_number VARCHAR(30) NOT NULL,
    account_holder VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected')),
    transaction_code VARCHAR(100),
    note TEXT,
    processed_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX idx_withdrawals_worker ON worker_withdrawals(worker_id, created_at DESC);

-- 10. Thợ báo cáo sự cố (khách vắng mặt, không thanh toán...) đi chung luồng khiếu nại của admin.
--     complaints.customer_id vẫn là khách của đơn. reporter_id: NULL = khách gửi (như cũ),
--     khác NULL = thợ gửi (id của thợ đó).
ALTER TABLE complaints ADD COLUMN reporter_id BIGINT REFERENCES users(id);
CREATE INDEX idx_complaints_reporter ON complaints(reporter_id) WHERE reporter_id IS NOT NULL;

-- 11. Vết di chuyển của thợ khi đang làm đơn (phục vụ tranh chấp), thưa ~1 điểm / 20 giây
CREATE TABLE worker_location_logs (
    id BIGSERIAL PRIMARY KEY,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
    order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_location_logs_worker ON worker_location_logs(worker_id, recorded_at DESC);

-- Down Migration
DROP TABLE IF EXISTS worker_location_logs;
ALTER TABLE complaints DROP COLUMN IF EXISTS reporter_id;
DROP TABLE IF EXISTS worker_withdrawals;
DROP INDEX IF EXISTS uq_worker_txn_order_type;
ALTER TABLE worker_transactions DROP COLUMN IF EXISTS withdrawal_id;
ALTER TABLE matching_configs DROP COLUMN IF EXISTS max_offers;
ALTER TABLE matching_configs DROP COLUMN IF EXISTS mode;
DROP TABLE IF EXISTS order_dispatches;
DROP INDEX IF EXISTS idx_offers_live;
ALTER TABLE order_offers DROP COLUMN IF EXISTS reason;
ALTER TABLE order_offers DROP COLUMN IF EXISTS round;
DROP TABLE IF EXISTS order_photos;
ALTER TABLE orders DROP COLUMN IF EXISTS safety_checked_at;
DROP TABLE IF EXISTS password_reset_codes;
DROP TABLE IF EXISTS worker_bank_accounts;
ALTER TABLE workers DROP COLUMN IF EXISTS submitted_at;
-- PostgreSQL không xoá được giá trị enum: 'cancelled' (offer/quote) và 'topup' giữ lại, không ảnh hưởng dữ liệu cũ
