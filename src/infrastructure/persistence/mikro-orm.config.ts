import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261118000000_initial_schema } from './migrations/Migration20261118000000_initial_schema';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
  entities: [],
  // Remove once the persistence entities exist.
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      {
        name: 'Migration20261118000000_initial_schema',
        class: Migration20261118000000_initial_schema,
      },
    ],
    transactional: true,
    snapshot: false,
  },
});
