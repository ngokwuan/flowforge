import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Periodically removes expired refresh tokens.
 *
 * Expired tokens are safe to delete.
 * Revoked tokens are retained until expiration for reuse detection.
 *
 * Runs every day at 3 AM.
 * Deletes records in batches to avoid long-running operations.
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

    while (true) {
      const batch = await this.prisma.refreshToken.findMany({
        where: {
          expiresAt: {
            lt: now,
          },
        },
        select: {
          id: true,
        },
        take: RefreshTokenCleanupService.BATCH_SIZE,
      });

      // Stop only when no more expired tokens exist.
      if (batch.length === 0) {
        break;
      }

      const { count } = await this.prisma.refreshToken.deleteMany({
        where: {
          id: {
            in: batch.map((token) => token.id),
          },
        },
      });

      totalDeleted += count;
    }

    this.logger.log(`RefreshToken cleanup done – deleted ${totalDeleted} rows`);
  }
}
