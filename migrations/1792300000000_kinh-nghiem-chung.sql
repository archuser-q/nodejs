-- Up Migration
-- [Thành viên B] Số năm kinh nghiệm là 1 con số chung của thợ (workers.experience_years), áp dụng cho mọi nhóm
-- dịch vụ đã chọn. Đồng bộ worker_skills.years (cột mà tiêu chí "kỹ năng" của hàm điểm ghép cặp đang đọc).
UPDATE worker_skills ws
SET years = w.experience_years
FROM workers w
WHERE w.user_id = ws.worker_id AND ws.years IS DISTINCT FROM w.experience_years;

-- Down Migration
-- Không khôi phục được số năm riêng của từng nhóm trước đây (dữ liệu cũ đã gộp); không cần làm gì.
SELECT 1;
