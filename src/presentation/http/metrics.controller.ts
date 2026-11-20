import { Controller, Get, Header } from '@nestjs/common';
import { registry } from '../../infrastructure/observability/metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return registry.render();
  }
}
