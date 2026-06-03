'use server';

import { and, eq } from 'drizzle-orm';
import { DBAccess } from '~/lib/db/db';
import { playbooks } from '~/lib/db/schema';
import { CustomPlaybook } from '~/lib/tools/custom-playbooks';
import { Playbook } from '~/lib/tools/playbooks';

function rowToCustomPlaybook(row: typeof playbooks.$inferSelect): CustomPlaybook {
  return {
    name: row.name,
    description: row.description || '',
    content: row.content as string,
    id: row.id,
    projectId: row.projectId,
    isBuiltIn: false,
    createdBy: row.createdBy
  };
}

export async function dbGetCustomPlaybooks(dbAccess: DBAccess, projectId: string): Promise<CustomPlaybook[]> {
  return await dbAccess.query(async ({ db }) => {
    const results = await db.select().from(playbooks).where(eq(playbooks.projectId, projectId));
    return results.map(rowToCustomPlaybook);
  });
}

export async function dbGetCustomPlaybookById(
  dbAccess: DBAccess,
  projectId: string,
  id: string
): Promise<CustomPlaybook | null> {
  return await dbAccess.query(async ({ db }) => {
    const result = await db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.projectId, projectId), eq(playbooks.id, id)))
      .limit(1);
    return result[0] ? rowToCustomPlaybook(result[0]) : null;
  });
}

export async function dbGetCustomPlaybookByName(
  dbAccess: DBAccess,
  projectId: string,
  name: string
): Promise<CustomPlaybook | null> {
  return await dbAccess.query(async ({ db }) => {
    const result = await db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.projectId, projectId), eq(playbooks.name, name)))
      .limit(1);
    return result[0] ? rowToCustomPlaybook(result[0]) : null;
  });
}

export async function dbListCustomPlaybookNames(dbAccess: DBAccess, projectId: string): Promise<string[]> {
  return await dbAccess.query(async ({ db }) => {
    const rows = await db.select({ name: playbooks.name }).from(playbooks).where(eq(playbooks.projectId, projectId));
    return rows.map((r) => r.name);
  });
}

export async function dbCreatePlaybook(dbAccess: DBAccess, input: CustomPlaybook): Promise<Playbook> {
  return await dbAccess.query(async ({ db, userId }) => {
    const existingPlaybook = await db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.name, input.name), eq(playbooks.projectId, input.projectId)))
      .limit(1);

    if (existingPlaybook.length > 0) {
      throw new Error(`Playbook with name "${input.name}" already exists in this project`);
    }

    const result = await db
      .insert(playbooks)
      .values({
        id: input.id,
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        content: input.content,
        createdBy: userId
      })
      .returning();

    const createdPlaybook = result[0];
    if (!createdPlaybook) {
      throw new Error('Failed to create playbook');
    }

    return {
      name: createdPlaybook.name,
      description: createdPlaybook.description || '',
      content: createdPlaybook.content as string,
      isBuiltIn: false
    };
  });
}

export async function dbUpdatePlaybook(
  dbAccess: DBAccess,
  id: string,
  input: { description?: string; content?: string }
): Promise<Playbook | null> {
  return await dbAccess.query(async ({ db }) => {
    const result = await db
      .update(playbooks)
      .set({ description: input.description, content: input.content })
      .where(eq(playbooks.id, id))
      .returning();

    const playbook = result[0];
    if (!playbook) {
      throw new Error(`Playbook with id ${id} not found`);
    }

    return {
      name: playbook.name,
      description: playbook.description || '',
      content: playbook.content as string,
      isBuiltIn: false
    };
  });
}

export async function dbDeletePlaybook(dbAccess: DBAccess, id: string): Promise<void> {
  return await dbAccess.query(async ({ db }) => {
    const result = await db.delete(playbooks).where(eq(playbooks.id, id)).returning();
    if (result.length === 0) {
      throw new Error(`Playbook with id ${id} not found`);
    }
  });
}
