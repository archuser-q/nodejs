INSERT INTO complaints (order_id, customer_id, type, title, content, image_urls, status, created_at)
SELECT
  o.id,
  o.customer_id,
  t.type,
  t.title,
  t.content,
  CASE WHEN random() < 0.5 THEN ARRAY['https://picsum.photos/seed/c' || o.id || '/600/400'] ELSE '{}' END,
  (CASE WHEN random() < 0.6 THEN 'open' ELSE 'processing' END)::complaint_status,
  LEAST(NOW(), o.completed_at + random() * INTERVAL '5 days')
FROM (
  SELECT * FROM orders
  WHERE status = 'completed'
    AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = orders.id)
  ORDER BY random()
  LIMIT 30
) AS o
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    ('complaint'::complaint_type, 'Thợ đến muộn', 'Hẹn 9h nhưng 10h30 thợ mới tới, không báo trước.'),
    ('complaint'::complaint_type, 'Giá cao hơn báo giá', 'Thợ thu thêm 200.000đ ngoài báo giá mà không giải thích.'),
    ('complaint'::complaint_type, 'Thái độ không tốt', 'Thợ nói chuyện thiếu tôn trọng.'),
    ('warranty'::complaint_type, 'Lỗi tái phát', 'Sửa xong được 1 tuần thì hỏng lại như cũ, đề nghị bảo hành.'),
    ('warranty'::complaint_type, 'Rò rỉ trở lại', 'Đường ống lại bị rò ở chỗ vừa sửa.')
  ) AS v(type, title, content)
  ORDER BY random() + o.id * 0
  LIMIT 1
) AS t;