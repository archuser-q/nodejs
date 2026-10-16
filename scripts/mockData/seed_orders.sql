INSERT INTO services (category_id, name, base_price, unit, warranty_days)
SELECT c.id, s.name, s.price, s.unit, s.warranty
FROM (VALUES
  ('Điện', 'Sửa ổ cắm, công tắc', 150000, 'điểm', 30),
  ('Điện', 'Lắp đặt đèn', 120000, 'bộ', 30),
  ('Nước', 'Sửa rò rỉ đường ống', 250000, 'lần', 60),
  ('Nước', 'Thông tắc bồn cầu', 300000, 'lần', 30),
  ('Điện lạnh', 'Vệ sinh điều hòa', 200000, 'máy', 0),
  ('Điện lạnh', 'Nạp gas điều hòa', 450000, 'máy', 90),
  ('Đồ gia dụng', 'Sửa máy giặt', 350000, 'lần', 60),
  ('Khóa - cửa', 'Mở khóa cửa', 200000, 'lần', 0),
  ('Sơn - chống thấm', 'Chống thấm tường', 180000, 'm²', 180)
) AS s(category, name, price, unit, warranty)
JOIN service_categories c ON c.name = s.category
ON CONFLICT (category_id, name) DO NOTHING;

INSERT INTO users (phone, full_name, role, created_at)
SELECT
  '094' || lpad(g::text, 7, '0'),
  (ARRAY['Nguyễn','Trần','Lê','Phạm','Hoàng','Vũ','Đặng','Bùi'])[1 + floor(random() * 8)::int] || ' ' ||
  (ARRAY['Thị','Văn','Minh','Thu','Ngọc','Hoàng'])[1 + floor(random() * 6)::int] || ' ' ||
  (ARRAY['Hà','Lan','Mai','Hương','Trang','Linh','Tùng','Khánh','Huy','Phúc'])[1 + floor(random() * 10)::int],
  'customer',
  NOW() - random() * INTERVAL '300 days'
FROM generate_series(1, 60) AS g
ON CONFLICT (phone) DO NOTHING;

CREATE TEMP TABLE seed_orders ON COMMIT DROP AS
SELECT
  g AS n,
  (SELECT id FROM users WHERE phone LIKE '094%' ORDER BY random() + g * 0 LIMIT 1) AS customer_id,
  (SELECT w.user_id FROM workers w JOIN users u ON u.id = w.user_id
     WHERE u.phone LIKE '093%' AND w.verification_status = 'approved' ORDER BY random() + g * 0 LIMIT 1) AS worker_id,
  (SELECT id FROM services ORDER BY random() + g * 0 LIMIT 1) AS service_id,
  CASE WHEN g <= 30 THEN NOW() - random() * INTERVAL '6 hours' ELSE NOW() - random() * INTERVAL '270 days' END AS created_at,
  random() AS r
FROM generate_series(1, 500) AS g;

INSERT INTO orders (
  code, customer_id, worker_id, service_id, address_text, location, description,
  status, matching_mode, estimated_price, final_price, commission_amount,
  accepted_at, started_at, completed_at, cancelled_at, cancelled_by, cancel_reason, warranty_until, created_at
)
SELECT
  'TNS' || lpad(t.n::text, 6, '0'),
  t.customer_id,
  CASE WHEN st.status IN ('pending', 'matching') OR (st.status = 'cancelled' AND t.r < 0.95) THEN NULL ELSE t.worker_id END,
  t.service_id,
  (ARRAY['Cầu Giấy','Đống Đa','Thanh Xuân','Hai Bà Trưng','Ba Đình','Hoàng Mai','Tây Hồ','Long Biên'])[1 + floor(random() * 8)::int]
    || ', Hà Nội',
  ST_SetSRID(ST_MakePoint(105.75 + random() * 0.15, 20.95 + random() * 0.12), 4326)::geography,
  'Khách mô tả sự cố',
  st.status,
  (CASE WHEN random() < 0.7 THEN 'instant' ELSE 'batch' END)::matching_mode,
  s.base_price,
  CASE WHEN st.status = 'completed' THEN s.base_price + (floor(random() * 4) * 50000) END,
  CASE WHEN st.status = 'completed' THEN round(s.base_price * 0.15) END,
  CASE WHEN st.status NOT IN ('pending', 'matching', 'cancelled') THEN t.created_at + INTERVAL '5 minutes' END,
  CASE WHEN st.status IN ('in_progress', 'completed') THEN t.created_at + INTERVAL '50 minutes' END,
  CASE WHEN st.status = 'completed' THEN t.created_at + INTERVAL '2 hours' END,
  CASE WHEN st.status = 'cancelled' THEN t.created_at + INTERVAL '10 minutes' END,
  CASE WHEN st.status = 'cancelled' THEN t.customer_id END,
  CASE WHEN st.status = 'cancelled' THEN 'Khách đổi lịch' END,
  CASE WHEN st.status = 'completed' AND s.warranty_days > 0 THEN t.created_at + INTERVAL '2 hours' + s.warranty_days * INTERVAL '1 day' END,
  t.created_at
FROM seed_orders t
JOIN services s ON s.id = t.service_id
CROSS JOIN LATERAL (
  SELECT (CASE
    WHEN t.n <= 30 THEN
      (ARRAY['pending','matching','accepted','on_the_way','arrived','in_progress'])[1 + floor(t.r * 6)::int]
    WHEN t.r < 0.82 THEN 'completed'
    ELSE 'cancelled'
  END)::order_status AS status
) AS st
ON CONFLICT (code) DO NOTHING;

INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, created_at)
SELECT o.id, steps.prev, steps.cur, NULL, o.created_at + steps.idx * INTERVAL '10 minutes'
FROM orders o
JOIN users u ON u.id = o.customer_id AND u.phone LIKE '094%'
CROSS JOIN LATERAL (
  SELECT
    idx,
    (CASE WHEN idx = 1 THEN NULL ELSE flow[idx - 1] END)::order_status AS prev,
    flow[idx]::order_status AS cur
  FROM (SELECT CASE WHEN o.status = 'cancelled'
                 THEN ARRAY['pending','cancelled']
                 ELSE (ARRAY['pending','matching','accepted','on_the_way','arrived','in_progress','completed'])[1:array_position(
                   ARRAY['pending','matching','accepted','on_the_way','arrived','in_progress','completed'], o.status::text)]
               END AS flow) f,
  generate_series(1, array_length(f.flow, 1)) AS idx
) AS steps
WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id);

INSERT INTO payments (order_id, method, amount, status, paid_at)
SELECT o.id,
       (ARRAY['cash','momo','vnpay'])[1 + floor(random() * 3)::int]::payment_method,
       o.final_price, 'success', o.completed_at
FROM orders o
JOIN users u ON u.id = o.customer_id AND u.phone LIKE '094%'
WHERE o.status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id);

INSERT INTO reviews (order_id, customer_id, worker_id, rating, comment, created_at)
SELECT o.id, o.customer_id, o.worker_id,
       (ARRAY[5,5,5,4,4,4,3,2,1])[1 + floor(random() * 9)::int],
       (ARRAY['Thợ làm nhanh, nhiệt tình','Giá hợp lý','Đến đúng giờ','Làm ổn','Hơi chậm',NULL])[1 + floor(random() * 6)::int],
       o.completed_at + INTERVAL '1 hour'
FROM orders o
JOIN users u ON u.id = o.customer_id AND u.phone LIKE '094%'
WHERE o.status = 'completed' AND o.worker_id IS NOT NULL AND random() < 0.7
ON CONFLICT (order_id) DO NOTHING;

INSERT INTO order_extra_quotes (order_id, worker_id, description, amount, status, responded_at, created_at)
SELECT o.id, o.worker_id, 'Thay thêm linh kiện', o.final_price - o.estimated_price, 'approved',
       o.started_at + INTERVAL '20 minutes', o.started_at + INTERVAL '15 minutes'
FROM orders o
WHERE o.code LIKE 'TNS%' AND o.status = 'completed' AND o.final_price > o.estimated_price
  AND NOT EXISTS (SELECT 1 FROM order_extra_quotes q WHERE q.order_id = o.id);

UPDATE orders SET extra_amount = final_price - estimated_price
WHERE code LIKE 'TNS%' AND status = 'completed';