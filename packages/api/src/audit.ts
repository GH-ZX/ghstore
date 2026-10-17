/**
 * The admin trail: who did what to which thing, one row in app.audit_log.
 * Pass the Db the change runs on (a transaction's own Db inside `db.tx`), so
 * the row commits or rolls back with the change it records.
 */
import type { Db } from "./db";

export interface AuditEntry {
  /** The person who acted (app.users.id). */
  actor: string;
  /** What they did, `thing.verb` (e.g. "offer.update"). */
  action: string;
  targetType: string;
  targetId: string;
  /** Details worth keeping; never secrets or decrypted values. */
  data?: Record<string, unknown>;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into app.audit_log (actor_user_id, action, target_type, target_id, data) values ($1, $2, $3, $4, $5::text::jsonb)`,
    [e.actor, e.action, e.targetType, e.targetId, JSON.stringify(e.data ?? {})],
  );
}
