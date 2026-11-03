/**
 * Jest globalTeardown cho E2E tests.
 *
 * DROP DATABASE test DB đã tạo trong globalSetup.
 */

import { Client } from 'pg';

export default async function globalTeardown() {
  const dbName = process.env.E2E_TEST_DB_NAME;
  const baseUrl = process.env.E2E_TEST_DB_BASE_URL;

  if (!dbName || !baseUrl) {
    // Không chạy qua globalSetup (ví dụ chạy test đơn lẻ) — bỏ qua.
    return;
  }

  const adminClient = new Client({ connectionString: baseUrl });
  await adminClient.connect();

  // Force-disconnect tất cả session đang kết nối đến test DB trước khi drop
  await adminClient.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()
  `, [dbName]);

  await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await adminClient.end();
}

