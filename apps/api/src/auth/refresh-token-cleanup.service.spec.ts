import { Test, TestingModule } from '@nestjs/testing';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RefreshTokenCleanupService', () => {
  let service: RefreshTokenCleanupService;
  let prisma: { refreshToken: { findMany: jest.Mock; deleteMany: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      refreshToken: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenCleanupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(RefreshTokenCleanupService);
  });

  it('does nothing when there are no stale tokens', async () => {
    prisma.refreshToken.findMany.mockResolvedValue([]);
    await service.cleanupExpiredTokens();
    expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes expired and revoked tokens in one batch', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    prisma.refreshToken.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]); // second call returns empty → stop
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });

    await service.cleanupExpiredTokens();

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
    });
  });

  it('runs multiple batches until empty', async () => {
    // Simulate exactly BATCH_SIZE rows in first batch, then 1, then empty
    const batchSize = (RefreshTokenCleanupService as any).BATCH_SIZE as number;
    const firstBatch = Array.from({ length: batchSize }, (_, i) => ({ id: `${i}` }));
    const secondBatch = [{ id: 'last' }];

    prisma.refreshToken.findMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch)
      .mockResolvedValueOnce([]);
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: batchSize });

    await service.cleanupExpiredTokens();

    expect(prisma.refreshToken.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(2);
  });
});

