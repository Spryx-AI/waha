import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import {
  GowsRuntimeContext,
  GowsRuntimeState,
} from '@waha/core/engines/gows/GowsRuntimeState';

@Injectable()
export class GowsRuntimeHealthIndicator extends HealthIndicator {
  constructor(private runtime: GowsRuntimeState) {
    super();
  }

  check(key: string, context: GowsRuntimeContext): HealthIndicatorResult {
    const snapshot = this.runtime.snapshot(context);
    const result = super.getStatus(key, snapshot.worker.ready, snapshot);
    if (!snapshot.worker.ready) {
      throw new HealthCheckError('GOWS worker is not ready', result);
    }
    return result;
  }
}
