import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NodeTypesController } from './node-types.controller';

@Module({
  imports: [AuthModule], // JwtAuthGuard needs JwtService
  controllers: [NodeTypesController],
})
export class NodeTypesModule {}
