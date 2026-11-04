import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Xóa định kỳ các RefreshToken đã hết hạn hoặc bị thu hồi.
 *
 * ADR 0002: "The RefreshToken table grows; expired and revoked rows need a
 * cleanup job."
 *
 * Chạy mỗi ngày lúc 3 giờ sáng. Xóa theo từng lô nhỏ để tránh khóa bảng
 * quá lâu khi bảng lớn.
 */
@Injectable()
export class RefreshTokenCleanupService {
  private readonly logger = new Logger(RefreshTokenCleanupService.name);
  private static readonly BATCH_SIZE = 1000;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredTokens(): Promise<void> {
    this.logger.log('Starting RefreshToken cleanup');
    const now = new Date();
    let totalDeleted = 0;

    // Delete in batches to avoid long-running transactions
    while (true) {
      const batch = await this.prisma.refreshToken.findMany({
        where: {
          OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
        },
        select: { id: true },
        take: RefreshTokenCleanupService.BATCH_SIZE,
      });

      if (batch.length === 0) break;

      const { count } = await this.prisma.refreshToken.deleteMany({
        where: { id: { in: batch.map((r) => r.id) } },
      });
      totalDeleted += count;

      if (batch.length < RefreshTokenCleanupService.BATCH_SIZE) break;
    }

    this.logger.log(`RefreshToken cleanup done – deleted ${totalDeleted} rows`);
  }
}
