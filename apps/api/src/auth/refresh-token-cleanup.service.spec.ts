import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';
import { PrismaService } from '../prisma/prisma.service';

type Row = { id: string };

describe('RefreshTokenCleanupService', () => {
  let service: RefreshTokenCleanupService;
  let findMany: jest.Mock<(args?: unknown) => Promise<Row[]>>;
  let deleteMany: jest.Mock<(args?: unknown) => Promise<{ count: number }>>;

  beforeEach(async () => {
    findMany = jest.fn<(args?: unknown) => Promise<Row[]>>();
    deleteMany = jest.fn<(args?: unknown) => Promise<{ count: number }>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenCleanupService,
        {
          provide: PrismaService,
          useValue: { refreshToken: { findMany, deleteMany } },
        },
      ],
    }).compile();

    service = module.get(RefreshTokenCleanupService);
  });

  it('does nothing when there are no stale tokens', async () => {
    findMany.mockResolvedValue([]);

    await service.cleanupExpiredTokens();

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('deletes the stale tokens it finds, in one batch', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]); // second call is empty, so it stops
    deleteMany.mockResolvedValue({ count: 2 });

    await service.cleanupExpiredTokens();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
    });
  });

  it('runs multiple batches until empty', async () => {
    // Exactly BATCH_SIZE rows in the first batch, then 1, then empty.
    const batchSize = (
      RefreshTokenCleanupService as unknown as { BATCH_SIZE: number }
    ).BATCH_SIZE;
    const firstBatch = Array.from({ length: batchSize }, (_, i) => ({
      id: `${i}`,
    }));
    const secondBatch = [{ id: 'last' }];

    findMany
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch)
      .mockResolvedValueOnce([]);
    deleteMany.mockResolvedValue({ count: batchSize });

    await service.cleanupExpiredTokens();

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it('only selects tokens past their expiry, so revoked tokens stay for reuse detection', async () => {
    findMany.mockResolvedValue([]);

    await service.cleanupExpiredTokens();

    const args = findMany.mock.calls[0][0] as { where: unknown };
    expect(args.where).toEqual({ expiresAt: { lt: expect.any(Date) } });
  });
});
