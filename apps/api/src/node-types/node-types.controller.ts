import { Controller, Get, UseGuards } from '@nestjs/common';
import { listNodeTypes } from '@flowforge/node-sdk';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

// Everything the editor needs to draw the node palette and each node's form.
// The web app never imports node-sdk: it contains server-only code.
@Controller('node-types')
@UseGuards(JwtAuthGuard)
export class NodeTypesController {
  private readonly types = listNodeTypes();

  @Get()
  list() {
    return this.types;
  }
}
