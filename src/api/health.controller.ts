import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { HealthCheck } from '@nestjs/terminus';

import { WAHAHealthCheckService } from '../core/abc/WAHAHealthCheckService';
import { PoliciesGuard } from '@waha/core/auth/policies.guard';
import { CheckPolicies } from '@waha/core/auth/policies.decorator';
import { CanServer } from '@waha/core/auth/policies';

import { Action } from '@waha/core/auth/casl.types';

@ApiSecurity('api_key')
@Controller('health')
@ApiTags('🔍 Observability')
@UseGuards(PoliciesGuard)
@CheckPolicies(CanServer(Action.Manage))
export class HealthController {
  constructor(private wahaHealth: WAHAHealthCheckService) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Check the health of the server',
    description:
      "Perform all health checks and return the server's health status.",
  })
  async check() {
    return this.wahaHealth.check();
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Check the readiness of the messaging runtime',
    description:
      'Report shared GOWS worker readiness and session-scoped event-stream evidence without sending a WhatsApp message.',
  })
  async readiness() {
    return this.wahaHealth.readiness();
  }
}
