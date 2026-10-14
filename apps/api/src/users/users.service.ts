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
        select: { id: true, email: true, name: true, createdAt: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        //status 409 Conflict
        throw new ConflictException({
          code: 'USER_EMAIL_TAKEN',
          message: 'Email đã được sử dụng',
        });
      }
      throw error;
    }
  }

  findForLogin(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, passwordHash: true },
    });
  }

  findPublicById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, createdAt: true },
    });
  }
}
