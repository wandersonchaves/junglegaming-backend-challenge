import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from './application/create-wallet/create-wallet.use-case';
import { Clock, IdGenerator } from './application/ports/clock-and-ids';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from './application/ports/tokens';
import { UnitOfWork } from './application/ports/unit-of-work';
import { SubmitWagerTransaction } from './application/submit-wager-transaction/submit-wager-transaction.use-case';
import config from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { RandomUuidGenerator, SystemClock } from './infrastructure/system/system-clock';
import { HealthController } from './presentation/health/health.controller';
import { DomainExceptionFilter } from './presentation/http/domain-exception.filter';
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
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(config) },
    DatabaseLifecycle,
    { provide: UNIT_OF_WORK, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
    { provide: CLOCK, useFactory: () => new SystemClock() },
    { provide: ID_GENERATOR, useFactory: () => new RandomUuidGenerator() },
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
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule { }
