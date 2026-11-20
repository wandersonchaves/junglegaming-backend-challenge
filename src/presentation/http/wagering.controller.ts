import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { WagerQueries } from '../../application/queries/wager-queries';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction/submit-wager-transaction.use-case';
import { metrics } from '../../infrastructure/observability/metrics';
import { StructuredLogger } from '../../infrastructure/observability/structured-logger';
import { parseSubmitWagerTransaction } from './request-parsers';

@Controller('wagering/transactions')
export class WageringController {
  private readonly logger = new StructuredLogger('wagering');

  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) { }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const startedAt = performance.now();
    const command = parseSubmitWagerTransaction(body, idempotencyKey, correlationId);
    const result = await this.submit.execute(command);

    // 201 new and processed · 200 replay of a processed one · 202 waiting for its reference
    // 422 rejected by a business rule (new or replayed)
    if (result.status === WagerTransactionStatus.Rejected) {
      response.status(422);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      response.status(202);
    } else {
      response.status(result.idempotentReplay ? 200 : 201);
    }

    metrics.transactions.inc({ status: result.status, source: 'http' });
    if (result.idempotentReplay) metrics.replays.inc({ source: 'http' });
    metrics.processingSeconds.observe((performance.now() - startedAt) / 1000, { source: 'http' });
    this.logger.info('transaction submitted', {
      correlationId: command.correlationId ?? result.transactionId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode,
      replay: result.idempotentReplay,
    });
    return result;
  }

  @Get(':transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }
}
