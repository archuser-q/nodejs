INSERT INTO matching_configs
  (name, w_distance, w_trust, w_skill, w_acceptance, w_workload, max_radius_km, offer_timeout_seconds, batch_window_seconds, is_active)
SELECT 'Mặc định', 0.35, 0.30, 0.15, 0.10, 0.10, 10, 30, 10, TRUE
WHERE NOT EXISTS (SELECT 1 FROM matching_configs);