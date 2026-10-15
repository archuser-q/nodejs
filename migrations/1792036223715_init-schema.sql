-- Up Migration
CREATE EXTENSION postgis;

CREATE TYPE user_role AS ENUM ('admin', 'worker', 'customer');
CREATE TYPE user_status AS ENUM ('active', 'locked', 'deleted');
CREATE TYPE verification_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE document_type AS ENUM ('id_card_front', 'id_card_back', 'certificate', 'portrait', 'other');
CREATE TYPE order_status AS ENUM ('pending', 'matching', 'accepted', 'on_the_way', 'arrived', 'in_progress', 'completed', 'cancelled');
CREATE TYPE matching_mode AS ENUM ('instant', 'batch');
CREATE TYPE offer_status AS ENUM ('offered', 'accepted', 'rejected', 'expired');
CREATE TYPE quote_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE payment_method AS ENUM ('cash', 'momo', 'vnpay');
CREATE TYPE payment_status AS ENUM ('pending', 'success', 'failed', 'refunded');
CREATE TYPE wallet_txn_type AS ENUM ('earning', 'commission', 'withdraw', 'refund', 'adjustment');
CREATE TYPE complaint_type AS ENUM ('complaint', 'warranty');
CREATE TYPE complaint_status AS ENUM ('open', 'processing', 'resolved', 'rejected');
CREATE TYPE device_platform AS ENUM ('android', 'ios', 'web');

CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    phone VARCHAR(15) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    full_name VARCHAR(100) NOT NULL,
    avatar_url TEXT,
    role user_role NOT NULL,
    status user_status NOT NULL DEFAULT 'active',
    google_id VARCHAR(100) UNIQUE,
    facebook_id VARCHAR(100) UNIQUE,
    phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE customer_addresses (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label VARCHAR(50),
    address_text TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE service_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    icon_url TEXT,
    description TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE services (
    id SERIAL PRIMARY KEY,
    category_id INT NOT NULL REFERENCES service_categories(id),
    name VARCHAR(150) NOT NULL,
    description TEXT,
    base_price NUMERIC(12, 0) NOT NULL CHECK (base_price >= 0),
    unit VARCHAR(30) NOT NULL DEFAULT 'lần',
    warranty_days INT NOT NULL DEFAULT 0 CHECK (warranty_days >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (category_id, name)
);

CREATE TABLE workers (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio TEXT,
    experience_years SMALLINT NOT NULL DEFAULT 0 CHECK (experience_years >= 0),
    verification_status verification_status NOT NULL DEFAULT 'pending',
    verified_at TIMESTAMPTZ,
    verified_by BIGINT REFERENCES users(id),
    is_online BOOLEAN NOT NULL DEFAULT FALSE,
    is_busy BOOLEAN NOT NULL DEFAULT FALSE,
    current_location GEOGRAPHY(POINT, 4326),
    location_updated_at TIMESTAMPTZ,
    service_radius_km NUMERIC(5, 2) NOT NULL DEFAULT 10,
    rating_avg NUMERIC(3, 2) NOT NULL DEFAULT 0,
    rating_count INT NOT NULL DEFAULT 0,
    trust_score NUMERIC(5, 4) NOT NULL DEFAULT 0,
    trust_updated_at TIMESTAMPTZ,
    is_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    total_jobs INT NOT NULL DEFAULT 0,
    acceptance_rate NUMERIC(5, 4) NOT NULL DEFAULT 1,
    cancel_rate NUMERIC(5, 4) NOT NULL DEFAULT 0,
    wallet_balance NUMERIC(14, 0) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE worker_documents (
    id BIGSERIAL PRIMARY KEY,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
    doc_type document_type NOT NULL,
    file_url TEXT NOT NULL,
    status verification_status NOT NULL DEFAULT 'pending',
    reviewed_by BIGINT REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    reject_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE worker_skills (
    worker_id BIGINT NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
    category_id INT NOT NULL REFERENCES service_categories(id),
    years SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (worker_id, category_id)
);

CREATE TABLE matching_configs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    w_distance NUMERIC(4, 3) NOT NULL,
    w_trust NUMERIC(4, 3) NOT NULL,
    w_skill NUMERIC(4, 3) NOT NULL,
    w_acceptance NUMERIC(4, 3) NOT NULL,
    w_workload NUMERIC(4, 3) NOT NULL,
    max_radius_km NUMERIC(5, 2) NOT NULL DEFAULT 10,
    offer_timeout_seconds INT NOT NULL DEFAULT 30,
    batch_window_seconds INT NOT NULL DEFAULT 10,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL REFERENCES users(id),
    worker_id BIGINT REFERENCES workers(user_id),
    service_id INT NOT NULL REFERENCES services(id),
    address_text TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    description TEXT,
    image_urls TEXT[] NOT NULL DEFAULT '{}',
    scheduled_at TIMESTAMPTZ,
    status order_status NOT NULL DEFAULT 'pending',
    matching_mode matching_mode NOT NULL DEFAULT 'instant',
    matching_config_id INT REFERENCES matching_configs(id),
    estimated_price NUMERIC(12, 0) NOT NULL,
    extra_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
    final_price NUMERIC(12, 0),
    commission_amount NUMERIC(12, 0),
    accepted_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_by BIGINT REFERENCES users(id),
    cancel_reason TEXT,
    warranty_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_status_history (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    from_status order_status,
    to_status order_status NOT NULL,
    changed_by BIGINT REFERENCES users(id),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_offers (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id),
    mode matching_mode NOT NULL,
    score NUMERIC(8, 5) NOT NULL,
    distance_km NUMERIC(7, 3),
    rank_position SMALLINT,
    status offer_status NOT NULL DEFAULT 'offered',
    offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ,
    UNIQUE (order_id, worker_id)
);

CREATE TABLE order_extra_quotes (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id),
    description TEXT NOT NULL,
    amount NUMERIC(12, 0) NOT NULL CHECK (amount > 0),
    image_urls TEXT[] NOT NULL DEFAULT '{}',
    status quote_status NOT NULL DEFAULT 'pending',
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payments (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id),
    method payment_method NOT NULL,
    amount NUMERIC(12, 0) NOT NULL CHECK (amount >= 0),
    status payment_status NOT NULL DEFAULT 'pending',
    provider_txn_id VARCHAR(100),
    provider_response JSONB,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE worker_transactions (
    id BIGSERIAL PRIMARY KEY,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id),
    order_id BIGINT REFERENCES orders(id),
    type wallet_txn_type NOT NULL,
    amount NUMERIC(14, 0) NOT NULL,
    balance_after NUMERIC(14, 0) NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reviews (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id),
    customer_id BIGINT NOT NULL REFERENCES users(id),
    worker_id BIGINT NOT NULL REFERENCES workers(user_id),
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    image_urls TEXT[] NOT NULL DEFAULT '{}',
    is_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    flag_reason TEXT,
    weight NUMERIC(5, 4) NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trust_score_history (
    id BIGSERIAL PRIMARY KEY,
    worker_id BIGINT NOT NULL REFERENCES workers(user_id) ON DELETE CASCADE,
    trust_score NUMERIC(5, 4) NOT NULL,
    simple_avg NUMERIC(3, 2) NOT NULL,
    review_count INT NOT NULL,
    params JSONB,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE complaints (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id),
    customer_id BIGINT NOT NULL REFERENCES users(id),
    type complaint_type NOT NULL DEFAULT 'complaint',
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    image_urls TEXT[] NOT NULL DEFAULT '{}',
    status complaint_status NOT NULL DEFAULT 'open',
    handled_by BIGINT REFERENCES users(id),
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id),
    content TEXT,
    image_url TEXT,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (content IS NOT NULL OR image_url IS NOT NULL)
);

CREATE TABLE notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    type VARCHAR(50) NOT NULL,
    data JSONB,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE device_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    platform device_platform NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX idx_services_category ON services(category_id);
CREATE INDEX idx_workers_location ON workers USING GIST (current_location);
CREATE INDEX idx_workers_available ON workers(is_online, is_busy) WHERE verification_status = 'approved';
CREATE INDEX idx_worker_documents_worker ON worker_documents(worker_id);
CREATE INDEX idx_worker_skills_category ON worker_skills(category_id);
CREATE UNIQUE INDEX uq_matching_config_active ON matching_configs(is_active) WHERE is_active;
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX idx_orders_worker ON orders(worker_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_location ON orders USING GIST (location);
CREATE INDEX idx_status_history_order ON order_status_history(order_id);
CREATE INDEX idx_offers_worker ON order_offers(worker_id, status);
CREATE INDEX idx_quotes_order ON order_extra_quotes(order_id);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_worker_txn_worker ON worker_transactions(worker_id, created_at DESC);
CREATE INDEX idx_reviews_worker ON reviews(worker_id, created_at DESC);
CREATE INDEX idx_trust_history_worker ON trust_score_history(worker_id, calculated_at DESC);
CREATE INDEX idx_complaints_status ON complaints(status, created_at DESC);
CREATE INDEX idx_messages_order ON messages(order_id, created_at);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
-- Down Migration
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

