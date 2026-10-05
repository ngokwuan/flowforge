import { config } from 'dotenv';
config({ path: '../../.env' });
// import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'demo@flowforge.dev' },
    update: {},
    create: {
      email: 'demo@flowforge.dev',
      name: 'Demo User',
      passwordHash: await argon2.hash('password123'),
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo' },
    update: {},
    create: { name: 'Demo Workspace', slug: 'demo' },
  });

  await prisma.membership.upsert({
    where: {
      userId_workspaceId: { userId: user.id, workspaceId: workspace.id },
    },
    update: {},
    create: { userId: user.id, workspaceId: workspace.id, role: 'OWNER' },
  });

  console.log('Seeded:', user.email, '→', workspace.slug);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
