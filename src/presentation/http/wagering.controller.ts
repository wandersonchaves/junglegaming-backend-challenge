import { Body, Controller, Headers, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction/submit-wager-transaction.use-case';
import { parseSubmitWagerTransaction } from './request-parsers';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
  ) { }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
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
    return result;
  }
}
