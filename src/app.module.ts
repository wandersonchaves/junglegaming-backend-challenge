import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from './application/create-wallet/create-wallet.use-case';
import { Clock, IdGenerator } from './application/ports/clock-and-ids';
import { OutboxBatchStore } from './application/ports/outbox-publishing';
import { ReadModel } from './application/ports/read-models';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from './application/ports/tokens';
import { UnitOfWork } from './application/ports/unit-of-work';
import { ProcessWagerMessage } from './application/process-wager-message/process-wager-message.use-case';
import { PublishOutbox } from './application/publish-outbox/publish-outbox.use-case';
import { WagerQueries } from './application/queries/wager-queries';
import { ReprocessPendingReferences } from './application/reprocess-pending-references/reprocess-pending-references.use-case';
import { SubmitWagerTransaction } from './application/submit-wager-transaction/submit-wager-transaction.use-case';
import { BackgroundServices, BackgroundTask } from './infrastructure/background-services';
import { AppConfig, loadConfig } from './infrastructure/config/app-config';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { metrics, registry } from './infrastructure/observability/metrics';
import config from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { PgOutboxBatchStore } from './infrastructure/persistence/pg-outbox-batch-store';
import { PgReadModel } from './infrastructure/persistence/pg-read-model';
import { Readiness } from './infrastructure/readiness';
import { RandomUuidGenerator, SystemClock } from './infrastructure/system/system-clock';
import { APP_CONFIG, BACKGROUND_TASKS, OUTBOX_STORE, READ_MODEL, SQS_CLIENT } from './infrastructure/tokens';
import { LoopWorker } from './infrastructure/workers/loop-worker';
import { AuthGuard } from './presentation/auth/auth.guard';
import { HealthController } from './presentation/health/health.controller';
import { DomainExceptionFilter } from './presentation/http/domain-exception.filter';
import { MetricsController } from './presentation/http/metrics.controller';
import { ProvidersController } from './presentation/http/providers.controller';
import { WageringController } from './presentation/http/wagering.controller';
import { WalletsController } from './presentation/http/wallets.controller';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) { }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

@Module({
  controllers: [
    HealthController,
    MetricsController,
    WalletsController,
    WageringController,
    ProvidersController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: MikroORM, useFactory: () => MikroORM.init(config) },
    DatabaseLifecycle,
    BackgroundServices,
    { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createSqsClient(c) },
    { provide: UNIT_OF_WORK, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
    { provide: OUTBOX_STORE, inject: [MikroORM], useFactory: (orm: MikroORM) => new PgOutboxBatchStore(orm) },
    { provide: READ_MODEL, inject: [MikroORM], useFactory: (orm: MikroORM) => new PgReadModel(orm) },
    { provide: CLOCK, useFactory: () => new SystemClock() },
    { provide: ID_GENERATOR, useFactory: () => new RandomUuidGenerator() },
    {
      provide: Readiness,
      inject: [MikroORM, SQS_CLIENT, APP_CONFIG],
      useFactory: (orm: MikroORM, sqs: SQSClient, c: AppConfig) => new Readiness(orm, sqs, c),
    },
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new SubmitWagerTransaction(uow, clock, ids),
    },
    {
      provide: WagerQueries,
      inject: [READ_MODEL],
      useFactory: (reads: ReadModel) => new WagerQueries(reads),
    },
    {
      provide: BACKGROUND_TASKS,
      inject: [APP_CONFIG, SQS_CLIENT, UNIT_OF_WORK, OUTBOX_STORE, CLOCK, ID_GENERATOR],
      useFactory: (
        c: AppConfig,
        sqs: SQSClient,
        uow: UnitOfWork,
        outbox: OutboxBatchStore,
        clock: Clock,
        ids: IdGenerator,
      ): BackgroundTask[] => {
        const tasks: BackgroundTask[] = [];

        if (c.consumerEnabled) {
          if (!c.wagerQueueUrl || !c.wagerDlqUrl) {
            throw new Error('WAGER_QUEUE_URL and WAGER_DLQ_URL are required (or set CONSUMER_ENABLED=false)');
          }
          tasks.push(
            new SqsWagerConsumer(
              sqs,
              { queueUrl: c.wagerQueueUrl, dlqUrl: c.wagerDlqUrl, waitTimeSeconds: c.consumerWaitSeconds },
              new ProcessWagerMessage(new SubmitWagerTransaction(uow, clock, ids)),
            ),
          );
        }

        if (c.workersEnabled) {
          if (!c.eventsQueueUrl) {
            throw new Error('WAGER_EVENTS_QUEUE_URL is required (or set WORKERS_ENABLED=false)');
          }
          const publish = new PublishOutbox(outbox, new SqsEventPublisher(sqs, c.eventsQueueUrl), clock);
          tasks.push(
            new LoopWorker(
              'outbox-publisher',
              async () => {
                const result = await publish.execute();
                if (result.failed > 0) metrics.retries.inc({ component: 'outbox_publisher' }, result.failed);
                return result.published + result.failed;
              },
              500,
            ),
          );

          const references = new ReprocessPendingReferences(uow, clock, ids);
          tasks.push(
            new LoopWorker(
              'pending-reference-worker',
              async () => {
                const result = await references.execute();
                if (result.stillWaiting > 0) {
                  metrics.retries.inc({ component: 'pending_reference' }, result.stillWaiting);
                }
                return result.checked;
              },
              2_000,
            ),
          );

          registry.gauge('outbox_lag_seconds', 'Age of the oldest event not published yet', () =>
            outbox.lagSeconds(new Date()),
          );
        }
        return tasks;
      },
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule { }
