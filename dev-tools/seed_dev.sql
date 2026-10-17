-- [DEV-TOOLS] Dữ liệu mẫu để chạy thử App Khách hàng (chạy được nhiều lần, không tạo trùng)
--   npm run seed:dev
-- Tạo: danh mục + dịch vụ, cấu hình ghép cặp mặc định, 40 thợ đã duyệt đang online quanh Hà Nội,
--      1 tài khoản khách demo: 0912345678 / 123456 (kèm 2 địa chỉ)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO service_categories (name, description, sort_order) VALUES
  ('Điện', 'Sửa chữa, lắp đặt điện dân dụng', 1),
  ('Nước', 'Đường ống, thiết bị vệ sinh', 2),
  ('Điện lạnh', 'Điều hòa, tủ lạnh', 3),
  ('Đồ gia dụng', 'Máy giặt, bình nóng lạnh...', 4),
  ('Khóa - cửa', 'Mở khóa, thay khóa, sửa cửa', 5),
  ('Sơn - chống thấm', 'Sơn sửa, chống thấm', 6)
ON CONFLICT (name) DO NOTHING;

INSERT INTO services (category_id, name, description, base_price, unit, warranty_days)
SELECT c.id, s.name, s.descr, s.price, s.unit, s.warranty
FROM (VALUES
  ('Điện', 'Sửa ổ cắm, công tắc', 'Thay, sửa ổ cắm/công tắc hỏng, chập', 150000, 'điểm', 30),
  ('Điện', 'Lắp đặt đèn', 'Lắp đèn trần, đèn LED, đèn trang trí', 120000, 'bộ', 30),
  ('Điện', 'Sửa cầu dao, aptomat', 'Thay aptomat, xử lý nhảy cầu dao', 200000, 'lần', 30),
  ('Điện', 'Đi dây điện mới', 'Đi lại dây điện âm/nổi tường', 300000, 'phòng', 90),
  ('Nước', 'Sửa rò rỉ đường ống', 'Tìm và xử lý điểm rò rỉ nước', 250000, 'lần', 60),
  ('Nước', 'Thông tắc bồn cầu', 'Thông tắc bồn cầu, bồn rửa', 300000, 'lần', 30),
  ('Điện lạnh', 'Vệ sinh điều hòa', 'Vệ sinh dàn nóng, dàn lạnh', 200000, 'máy', 0),
  ('Điện lạnh', 'Nạp gas điều hòa', 'Kiểm tra và nạp gas', 450000, 'máy', 90),
  ('Điện lạnh', 'Sửa tủ lạnh', 'Tủ lạnh không lạnh, chảy nước', 350000, 'lần', 60),
  ('Đồ gia dụng', 'Sửa máy giặt', 'Máy giặt không vắt, kêu to, báo lỗi', 350000, 'lần', 60),
  ('Khóa - cửa', 'Mở khóa cửa', 'Mở khóa khi mất chìa', 200000, 'lần', 0),
  ('Sơn - chống thấm', 'Chống thấm tường', 'Xử lý tường thấm, ẩm mốc', 180000, 'm²', 180)
) AS s(category, name, descr, price, unit, warranty)
JOIN service_categories c ON c.name = s.category
ON CONFLICT (category_id, name) DO NOTHING;

INSERT INTO matching_configs
  (name, w_distance, w_trust, w_skill, w_acceptance, w_workload, max_radius_km, offer_timeout_seconds, batch_window_seconds, is_active)
SELECT 'Mặc định', 0.35, 0.30, 0.15, 0.10, 0.10, 10, 30, 10, TRUE
WHERE NOT EXISTS (SELECT 1 FROM matching_configs WHERE is_active);

-- 40 thợ: 20 quanh trung tâm Hà Nội, 20 quanh Hà Đông (PTIT)
INSERT INTO users (phone, full_name, role)
SELECT '093' || lpad(g::text, 7, '0'),
       (ARRAY['Nguyễn','Trần','Lê','Phạm','Hoàng','Vũ','Đặng','Bùi'])[1 + g % 8] || ' ' ||
       (ARRAY['Văn','Minh','Đức','Quang','Hữu'])[1 + g % 5] || ' ' ||
       (ARRAY['An','Bình','Cường','Dũng','Hùng','Long','Nam','Sơn','Tuấn','Việt'])[1 + g % 10],
       'worker'
FROM generate_series(1, 40) AS g
ON CONFLICT (phone) DO NOTHING;

INSERT INTO workers (user_id, bio, experience_years, verification_status, verified_at, is_online,
                     current_location, location_updated_at, rating_avg, rating_count, trust_score,
                     total_jobs, acceptance_rate)
SELECT u.id,
       'Thợ có kinh nghiệm, làm việc cẩn thận, đúng giờ.',
       1 + (n % 9),
       'approved', NOW(), TRUE,
       ST_SetSRID(ST_MakePoint(
         CASE WHEN n <= 20 THEN 105.8542 ELSE 105.7874 END + (random() - 0.5) * 0.10,
         CASE WHEN n <= 20 THEN 21.0285 ELSE 20.9808 END + (random() - 0.5) * 0.08
       ), 4326)::geography,
       NOW(),
       round((3.8 + random() * 1.2)::numeric, 2), 5 + (n * 7) % 60,
       round((0.55 + random() * 0.4)::numeric, 4),
       10 + (n * 13) % 200, round((0.7 + random() * 0.3)::numeric, 4)
FROM (SELECT id, substr(phone, 4)::int AS n FROM users WHERE phone LIKE '093%' AND role = 'worker') u
ON CONFLICT (user_id) DO NOTHING;

-- Mỗi thợ 2–3 kỹ năng
INSERT INTO worker_skills (worker_id, category_id, years)
SELECT w.user_id, c.id, 1 + (w.user_id + c.id) % 10
FROM workers w
JOIN users u ON u.id = w.user_id AND u.phone LIKE '093%'
JOIN service_categories c ON (w.user_id + c.sort_order) % 3 <> 0 OR c.sort_order = 1 + w.user_id % 6
ON CONFLICT DO NOTHING;

-- Khách demo
INSERT INTO users (phone, email, password_hash, full_name, role)
VALUES ('0912345678', 'khachdemo@thonhanh.vn', crypt('123456', gen_salt('bf', 10)), 'Khách Demo', 'customer')
ON CONFLICT (phone) DO NOTHING;

INSERT INTO customer_addresses (customer_id, label, address_text, location, is_default)
SELECT u.id, a.label, a.addr, ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326)::geography, a.def
FROM users u
CROSS JOIN (VALUES
  ('Nhà', '122 Hoàng Quốc Việt, Cầu Giấy, Hà Nội', 21.0466, 105.7980, TRUE),
  ('Trường', 'Km10 Nguyễn Trãi, Hà Đông, Hà Nội', 20.9808, 105.7874, FALSE)
) AS a(label, addr, lat, lng, def)
WHERE u.phone = '0912345678'
  AND NOT EXISTS (SELECT 1 FROM customer_addresses ca WHERE ca.customer_id = u.id);
