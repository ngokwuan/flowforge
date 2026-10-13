import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { RegisterInput } from '@flowforge/shared';
import { UsersService } from '../users/users.service';

// argon2id with the OWASP minimum parameters (19 MiB memory, 2 iterations).
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class AuthService {
  constructor(private readonly users: UsersService) {}

  async register(input: RegisterInput) {
    // Normalize so "A@x.com" and "a@x.com" cannot become two accounts.
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hash(input.password, ARGON2_OPTIONS);

    return this.users.createWithPersonalWorkspace({
      email,
      name: input.name,
      passwordHash,
    });
  }
}
