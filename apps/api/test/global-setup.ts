/**
 * Jest globalSetup cho E2E tests.
 *
 * Tạo một database riêng cho mỗi lần chạy test suite:
 *   flowforge_test_<timestamp>
 *
 * Sau khi tạo, chạy prisma migrate deploy để áp dụng toàn bộ migration,
 * rồi ghi DATABASE_URL vào process.env để toàn bộ test suite dùng.
 *
 * ADR 0004: "A dedicated test database, migrated before each run, is the next
 * step if the number of suites grows."
 */

import { execSync } from 'node:child_process';
import { config } from 'dotenv';
import { Client } from 'pg';
import path from 'node:path';

export default async function globalSetup() {
  // Load .env từ root monorepo (../../.env tính từ apps/api)
  config({ path: path.resolve(__dirname, '../../..', '.env'), quiet: true });

  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('[E2E globalSetup] DATABASE_URL is not set');
  }

  // Tạo tên DB test duy nhất theo timestamp
  const dbName = `flowforge_test_${Date.now()}`;
  const testUrl = buildTestUrl(baseUrl, dbName);

  // Kết nối đến DB mặc định để CREATE DATABASE
  const adminClient = new Client({ connectionString: baseUrl });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();

  // Chạy migrate deploy trên test DB
  execSync('prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
    },
    stdio: 'pipe',
  });

  // Lưu để các test suite và globalTeardown dùng
  process.env.DATABASE_URL = testUrl;
  process.env.E2E_TEST_DB_NAME = dbName;
  process.env.E2E_TEST_DB_BASE_URL = baseUrl;
}

function buildTestUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
