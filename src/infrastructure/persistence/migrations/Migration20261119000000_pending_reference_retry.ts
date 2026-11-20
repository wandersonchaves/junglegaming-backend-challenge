import { Migration } from '@mikro-orm/migrations';

export class Migration20261119000000_pending_reference_retry extends Migration {
  override up(): void {
    // Retry bookkeeping for reversals that arrived before their reference.
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN reference_next_attempt_at timestamptz,
        ADD CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0);
    `);
    this.addSql(`DROP INDEX wager_tx_pending_reference_idx;`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (reference_next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql(`DROP INDEX wager_tx_pending_reference_idx;`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (created_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT wager_tx_reference_attempts_non_negative,
        DROP COLUMN reference_next_attempt_at,
        DROP COLUMN reference_attempts;
    `);
  }
}
