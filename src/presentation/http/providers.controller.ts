import { Controller, Get, Inject, Param } from '@nestjs/common';
import { WagerQueries } from '../../application/queries/wager-queries';

@Controller('providers')
export class ProvidersController {
  constructor(@Inject(WagerQueries) private readonly queries: WagerQueries) { }

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
