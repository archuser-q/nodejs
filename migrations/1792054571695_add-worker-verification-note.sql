-- Up Migration
ALTER TABLE workers ADD COLUMN verification_note TEXT;

-- Down Migration
ALTER TABLE workers DROP COLUMN verification_note;

--INSERT INTO service_categories (name) VALUES ('Điện'), ('Nước') ON CONFLICT DO NOTHING;
--
--INSERT INTO users (phone, full_name, role) VALUES ('0902000001', 'Lê Văn Cường', 'worker');
--
--INSERT INTO workers (user_id, experience_years, rating_avg, rating_count, trust_score, total_jobs)
--SELECT id, 5, 4.6, 12, 0.87, 20 FROM users WHERE phone = '0902000001';
--
--INSERT INTO worker_skills (worker_id, category_id)
--SELECT u.id, c.id FROM users u, service_categories c WHERE u.phone = '0902000001';
--
--INSERT INTO worker_documents (worker_id, doc_type, file_url)
--SELECT id, 'id_card_front'::document_type, 'https://picsum.photos/seed/cccd/600/380' FROM users WHERE phone = '0902000001'
--UNION ALL
--SELECT id, 'certificate'::document_type, 'https://picsum.photos/seed/cert/600/800' FROM users WHERE phone = '0902000001';