// Phải import ĐẦU TIÊN trong mọi file test: đặt biến môi trường trước khi code app đọc cấu hình.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://thonhanh:thonhanh@localhost:5432/thonhanh_test';
process.env.JWT_SECRET ||= 'test_secret_test_secret_test_secret';
process.env.JWT_EXPIRES_IN ||= '1d';
process.env.CLIENT_ORIGIN ||= 'http://localhost:5173';
process.env.PORT ||= '0';
process.env.DISPATCHER_ENABLED = 'false'; // test tự gọi từng bước điều phối
process.env.MEDIA_DIR = process.env.TEST_MEDIA_DIR || '/tmp/thonhanh-test-media';
process.env.WITHDRAWAL_AUTO_APPROVE = 'true';
process.env.SANDBOX_TOPUP = 'true';
