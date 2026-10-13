import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { slugify } from '../common/utils/slugify';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // Creates the user together with a personal workspace they own.
  // Prisma runs nested writes in one transaction, so a user can never exist
  // without their workspace and membership.
  async createWithPersonalWorkspace(input: CreateUserInput) {
    // Random suffix keeps the slug unique; a collision is ~1 in 16 million.
    const slug = `${slugify(input.name)}-${randomBytes(3).toString('hex')}`;

    try {
      return await this.prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: input.passwordHash,
          memberships: {
            create: {
              role: 'OWNER',
              workspace: {
                create: { name: `Workspace của ${input.name}`, slug },
              },
            },
          },
        },
        // Never select passwordHash for a response.
        select: { id: true, email: true, name: true, createdAt: true },
      });
    } catch (error) {
      // Rely on the unique constraint instead of "check, then insert":
      // two concurrent requests can both pass a check, but not the constraint.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'USER_EMAIL_TAKEN',
          message: 'Email đã được sử dụng',
        });
      }
      throw error;
    }
  }
}
