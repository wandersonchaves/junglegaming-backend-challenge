import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000000_initial_schema extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid         PRIMARY KEY,
        player_id   uuid         NOT NULL,
        currency    char(3)      NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer      NOT NULL DEFAULT 1,
        created_at  timestamptz  NOT NULL DEFAULT now(),
        updated_at  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_key UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        text          NOT NULL,
        external_transaction_id            text          NOT NULL,
        idempotency_key                    text          NOT NULL,
        payload_hash                       char(64)      NOT NULL,
        wallet_id                          uuid          NOT NULL,
        player_id                          uuid          NOT NULL,
        round_id                           text          NOT NULL,
        game_id                            text          NOT NULL,
        kind                               text          NOT NULL,
        amount                             numeric(20,2) NOT NULL,
        currency                           char(3)       NOT NULL,
        status                             text          NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid          REFERENCES wager_transactions (id),
        failure_code                       text,
        balance_after                      numeric(20,2),
        created_at                         timestamptz   NOT NULL DEFAULT now(),
        processed_at                       timestamptz,
        CONSTRAINT wager_tx_idempotency_key_key UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_tx_reference_required CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_required CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_processed_at_required CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)
      );
    `);

    // A reference can be reversed only once per reversal kind.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_idx
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED'
          AND kind IN ('REFUND','ROLLBACK')
          AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (created_at)
        WHERE status = 'PENDING_REFERENCE';
    `);

    // Terminal states never change again.
    this.addSql(`
      CREATE FUNCTION wager_tx_forbid_terminal_change() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is in terminal status % and cannot change', OLD.id, OLD.status;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_terminal_guard
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_forbid_terminal_change();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions (id),
        direction       text          NOT NULL,
        amount          numeric(20,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL,
        balance_after   numeric(20,2) NOT NULL,
        created_at      timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_one_entry_per_wallet_tx UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'DEBIT'  AND balance_after = balance_before - amount) OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        )
      );
    `);
    this.addSql(`CREATE INDEX ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id);`);

    // The ledger is append-only.
    this.addSql(`
      CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text         NOT NULL,
        message_id     text         NOT NULL,
        payload_hash   char(64)     NOT NULL,
        received_at    timestamptz  NOT NULL DEFAULT now(),
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,
        aggregate_id     text         NOT NULL,
        event_type       text         NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz  NOT NULL DEFAULT now(),
        published_at     timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_forbid_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_forbid_terminal_change();`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
