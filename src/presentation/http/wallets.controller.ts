import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CreateWallet } from '../../application/create-wallet/create-wallet.use-case';
import { WagerQueries } from '../../application/queries/wager-queries';
import { metrics } from '../../infrastructure/observability/metrics';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger';
import { InvalidRequestError } from './invalid-request.error';
import { parseCreateWallet } from './request-parsers';

@Controller('wallets')
export class WalletsController {
  private readonly logger = new StructuredLogger('wallets');

  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) { }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.createWallet.execute(parseCreateWallet(body));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    let parsed: number | undefined;
    if (limit !== undefined) {
      parsed = Number(limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new InvalidRequestError('limit must be a positive integer');
      }
    }
    return this.queries.listLedger(walletId, cursor, parsed);
  }

  /** Compares the stored balance with the ledger. Divergences are reported, never fixed here. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const result = await this.queries.reconcile(walletId);
    if (!result.consistent) {
      metrics.reconciliationDivergences.inc();
      this.logger.error('wallet balance diverges from the ledger', {
        walletId,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}
