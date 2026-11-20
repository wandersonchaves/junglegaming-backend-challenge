import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261118000000_initial_schema } from './migrations/Migration20261118000000_initial_schema';
import { Migration20261119000000_pending_reference_retry } from './migrations/Migration20261119000000_pending_reference_retry';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
  entities: [],
  pool: { min: 2, max: 20 },
  // Remove once the persistence entities exist.
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      {
        name: 'Migration20261118000000_initial_schema',
        class: Migration20261118000000_initial_schema,
      },
      {
        name: 'Migration20261119000000_pending_reference_retry',
        class: Migration20261119000000_pending_reference_retry,
      },
    ],
    transactional: true,
    snapshot: false,
  },
});
