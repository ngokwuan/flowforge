#!/usr/bin/env bash
# FlowForge scaffold. Run from the repo root:  bash bootstrap.sh
# Existing files are never overwritten.
set -e

write() {
  if [ -e "$1" ]; then
    echo "skip   $1 (already exists)"
    cat > /dev/null
  else
    mkdir -p "$(dirname "$1")"
    cat > "$1"
    echo "create $1"
  fi
}

mkdir -p apps packages/shared/src docs/adr .github/workflows

write package.json <<'EOF'
{
  "name": "flowforge",
  "private": true,
  "packageManager": "pnpm@12.9.1",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test"
  }
}
EOF

write pnpm-workspace.yaml <<'EOF'
packages:
  - "apps/*"
  - "packages/*"
EOF

write turbo.json <<'EOF'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
EOF

write tsconfig.base.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "forceConsistentCasingInFileNames": true
  }
}
EOF

write .gitignore <<'EOF'
node_modules
dist
.next
.turbo
coverage
.env
*.log
.DS_Store
EOF

write .env.example <<'EOF'
DATABASE_URL=postgresql://flowforge:flowforge@localhost:5432/flowforge
REDIS_URL=redis://localhost:6379

JWT_ACCESS_SECRET=change-me-access
JWT_REFRESH_SECRET=change-me-refresh
# 32 bytes, base64. Generate: openssl rand -base64 32
CREDENTIAL_ENCRYPTION_KEY=

S3_ENDPOINT=http://localhost:9000
S3_BUCKET=flowforge
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin

# mock | gemini | anthropic | openai
LLM_PROVIDER=mock
LLM_API_KEY=

OAUTH_GOOGLE_CLIENT_ID=
OAUTH_GOOGLE_CLIENT_SECRET=
EOF

write docker-compose.yml <<'EOF'
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: flowforge
      POSTGRES_PASSWORD: flowforge
      POSTGRES_DB: flowforge
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7
    ports: ["6379:6379"]
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]
volumes:
  pgdata:
  miniodata:
EOF

write .github/workflows/ci.yml <<'EOF'
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build
EOF

write packages/shared/package.json <<'EOF'
{
  "name": "@flowforge/shared",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch"
  }
}
EOF

write packages/shared/tsconfig.json <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
EOF

write packages/shared/src/index.ts <<'EOF'
import { z } from "zod";

export const Role = z.enum(["OWNER", "EDITOR", "VIEWER"]);
export type Role = z.infer<typeof Role>;

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
  name: z.string().min(1).max(100),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;
EOF

write docs/adr/0001-modular-monolith-with-worker.md <<'EOF'
# ADR 0001: Modular monolith with a dedicated worker

## Status
Accepted

## Context
FlowForge has one component with a different load and failure profile
(the execution engine) and several tightly related domains (auth,
workspaces, workflows, credentials). The team is one person.

## Decision
Run `core-api` as a modular NestJS monolith and `engine-worker` as a
separate process. Modules talk through services and events, never through
each other's repositories.

## Consequences
- Low operational cost: two deployables instead of many.
- The worker scales independently and isolates untrusted logic.
- Further splits (for example webhook ingress) stay cheap because module
  boundaries are already enforced.
- Revisit if load tests show another component is a bottleneck.
EOF

echo
echo "Done. Next steps are in the chat."
