import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Readiness } from '../../infrastructure/readiness';

@Controller('health')
export class HealthController {
  constructor(@Inject(Readiness) private readonly readiness: Readiness) { }

  /** The process is alive. Does not look at dependencies. */
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** PostgreSQL and SQS are reachable. 503 when one of them is not. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.readiness.check();
    if (report.status !== 'ready') response.status(503);
    return report;
  }
}
