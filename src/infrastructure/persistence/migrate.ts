import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    console.error('usage: bun run src/infrastructure/persistence/migrate.ts <up|down>');
    process.exit(1);
  }

  const orm = await MikroORM.init(config);
  try {
    if (direction === 'up') {
      await orm.migrator.up();
    } else {
      await orm.migrator.down();
    }
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
