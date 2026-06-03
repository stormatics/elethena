'use server';

import { and, eq, sql } from 'drizzle-orm';
import { TtlCache } from './cache';
import { DBAccess } from './db';
import { Connection, connections, Schedule } from './schema';

const connectionByIdCache = new TtlCache<string, Connection>(60_000, 1000);

export async function listConnections(dbAccess: DBAccess, projectId: string): Promise<Connection[]> {
  return dbAccess.query(async ({ db }) => {
    return await db.select().from(connections).where(eq(connections.projectId, projectId));
  });
}

export async function getDefaultConnection(dbAccess: DBAccess, projectId: string): Promise<Connection | null> {
  return dbAccess.query(async ({ db }) => {
    const result = await db
      .select()
      .from(connections)
      .where(and(eq(connections.projectId, projectId), eq(connections.isDefault, true)));
    return result[0] ?? null;
  });
}

export async function getConnection(dbAccess: DBAccess, id: string): Promise<Connection | null> {
  const cached = connectionByIdCache.get(id);
  if (cached) return cached;
  return dbAccess.query(async ({ db }) => {
    const result = await db.select().from(connections).where(eq(connections.id, id));
    const row = result[0] ?? null;
    if (row) connectionByIdCache.set(id, row);
    return row;
  });
}

export async function getConnectionByName(
  dbAccess: DBAccess,
  projectId: string,
  name: string
): Promise<Connection | null> {
  return dbAccess.query(async ({ db }) => {
    const result = await db
      .select()
      .from(connections)
      .where(and(eq(connections.projectId, projectId), eq(connections.name, name)));
    return result[0] ?? null;
  });
}

export async function getConnectionFromSchedule(dbAccess: DBAccess, schedule: Schedule): Promise<Connection | null> {
  return dbAccess.query(async ({ db }) => {
    const result = await db.select().from(connections).where(eq(connections.id, schedule.connectionId));
    return result[0] ?? null;
  });
}

export async function makeConnectionDefault(dbAccess: DBAccess, id: string): Promise<void> {
  return dbAccess.query(async ({ db }) => {
    await db.transaction(async (trx) => {
      await trx.update(connections).set({ isDefault: false }).where(eq(connections.isDefault, true));
      await trx.update(connections).set({ isDefault: true }).where(eq(connections.id, id));
    });
  });
}

export async function deleteConnection(dbAccess: DBAccess, id: string): Promise<void> {
  connectionByIdCache.delete(id);
  return dbAccess.query(async ({ db }) => {
    await db.transaction(async (trx) => {
      const wasDefault = await trx
        .select({ isDefault: connections.isDefault })
        .from(connections)
        .where(eq(connections.id, id));
      await trx.delete(connections).where(eq(connections.id, id));
      if (wasDefault[0]?.isDefault) {
        const nextConnection = await trx.select({ id: connections.id }).from(connections).limit(1);
        if (nextConnection[0]) {
          await trx.update(connections).set({ isDefault: true }).where(eq(connections.id, nextConnection[0].id));
        }
      }
    });
  });
}

export async function addConnection(
  dbAccess: DBAccess,
  {
    projectId,
    name,
    connectionString,
    cores,
    memoryGib
  }: {
    projectId: string;
    name: string;
    connectionString: string;
    cores?: number | null;
    memoryGib?: number | null;
  }
): Promise<Connection> {
  return dbAccess.query(async ({ db }) => {
    // EXISTS is O(1) — used to compute isDefault without pulling all rows.
    const existsResult = await db.execute(
      sql`SELECT EXISTS(SELECT 1 FROM connections WHERE project_id = ${projectId}) AS exists`
    );
    const rows = ((existsResult as any).rows ?? existsResult) as Array<{ exists: boolean }>;
    const hasExisting = rows[0]?.exists === true;
    const result = await db
      .insert(connections)
      .values({
        projectId,
        name,
        connectionString,
        cores: cores ?? null,
        memoryGib: memoryGib ?? null,
        isDefault: !hasExisting
      })
      .returning();
    if (!result[0]) {
      throw new Error('Error adding connection');
    }
    return result[0];
  });
}

export async function updateConnection(
  dbAccess: DBAccess,
  {
    id,
    name,
    connectionString,
    cores,
    memoryGib
  }: {
    id: string;
    name: string;
    connectionString: string;
    cores?: number | null;
    memoryGib?: number | null;
  }
): Promise<Connection> {
  connectionByIdCache.delete(id);
  return dbAccess.query(async ({ db }) => {
    const result = await db
      .update(connections)
      .set({ name, connectionString, cores: cores ?? null, memoryGib: memoryGib ?? null })
      .where(eq(connections.id, id))
      .returning();
    if (!result[0]) {
      throw new Error('Connection not found');
    }
    return result[0];
  });
}
