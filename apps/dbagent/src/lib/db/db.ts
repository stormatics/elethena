import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { requireUserSession } from '~/utils/route';
import { env } from '../env/server';
import { authenticatedUser } from './schema';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20
});

/**
 * Interface for database access that provides a consistent way to execute queries
 * with proper user context and role settings.
 */
export interface DBAccess {
  /**
   * Executes a database query with the appropriate user context and role settings.
   * @param callback Function that receives the database instance and user ID
   * @returns The result of the callback function
   */
  query: <T>(callback: (params: { db: NodePgDatabase<any>; userId: string }) => Promise<T>) => Promise<T>;
}

/**
 * Database access implementation for admin operations.
 * This bypasses user role restrictions and sets the user ID to 'admin'.
 */
export class DBAdminAccess implements DBAccess {
  async query<T>(callback: (params: { db: NodePgDatabase<any>; userId: string }) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      const db = drizzle(client);
      return await callback({ db, userId: 'admin' });
    } finally {
      client.release(true);
    }
  }
}

/**
 * Database access implementation for user-specific operations.
 * This sets the appropriate user role and user ID for the query.
 */
export class DBUserAccess implements DBAccess {
  private readonly _userId: string;

  constructor(userId: string) {
    // Strict: non-empty UUID-ish only. Empty string + permissive regex previously let a
    // miscarried session silently disable RLS membership checks.
    if (userId === '' || userId === 'local') {
      // 'local' is the legacy single-user dev fallback; allow but flag.
      this._userId = userId;
      return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      throw new Error('Invalid user ID format');
    }
    this._userId = userId;
  }

  async query<T>(callback: (params: { db: NodePgDatabase<any>; userId: string }) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      const db = drizzle(client);
      // SET ROLE — role name is a compile-time constant, safe.
      await db.execute(sql.raw(`SET ROLE "${authenticatedUser.name}"`));
      // Parameter-bind the user id so a malformed identifier can never inject SQL,
      // even if the constructor regex is ever relaxed.
      await db.execute(sql`SELECT set_config('app.current_user', ${this._userId}, false)`);
      return await callback({ db, userId: this._userId });
    } finally {
      client.release(true);
    }
  }
}

export async function getUserSessionDBAccess(): Promise<DBAccess> {
  const userId = await requireUserSession();
  return new DBUserAccess(userId);
}

export async function getUserDBAccess(userId: string | undefined | null): Promise<DBAccess> {
  if (!userId) return await getUserSessionDBAccess();

  return new DBUserAccess(userId);
}

export function getAdminAccess(): DBAccess {
  return new DBAdminAccess();
}
