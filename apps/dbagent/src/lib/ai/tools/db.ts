import { Tool, tool } from 'ai';
import { z } from 'zod';
import { getPerformanceAndVacuumSettings, toolFindTableSchema } from '~/lib/tools/dbinfo';
import {
  toolDescribeTable,
  toolGetSlowQueries,
  toolSafeExplainQuery,
  toolUnsafeExplainQuery
} from '~/lib/tools/slow-queries';
import {
  toolCurrentActiveQueries,
  toolGetConnectionsGroups,
  toolGetConnectionsStats,
  toolGetQueriesWaitingOnLocks,
  toolGetVacuumStats
} from '~/lib/tools/stats';
import { ToolsetGroup } from './types';

import { AuditContext } from '~/lib/targetdb/audit';
import { Pool, withAuditedReadOnlyConnection } from '~/lib/targetdb/db';

export function getDBSQLTools(targetDb: Pool, audit: AuditContext): DBSQLTools {
  return new DBSQLTools(targetDb, audit);
}

// The DBSQLTools toolset provides tools for querying the postgres database
// directly via SQL to collect system performance information. Every query
// runs inside a read-only transaction and is recorded in target_db_audit.
export class DBSQLTools implements ToolsetGroup {
  #pool: Pool | (() => Promise<Pool>);
  #audit: AuditContext;

  constructor(pool: Pool | (() => Promise<Pool>), audit: AuditContext) {
    this.#pool = pool;
    this.#audit = audit;
  }

  private run<T>(fn: (client: import('~/lib/targetdb/db').ClientBase) => Promise<T>): Promise<T> {
    return withAuditedReadOnlyConnection(this.#pool, this.#audit, fn);
  }

  toolset(): Record<string, Tool> {
    return {
      getSlowQueries: this.getSlowQueries(),
      unsafeExplainQuery: this.unsafeExplainQuery(),
      safeExplainQuery: this.safeExplainQuery(),
      describeTable: this.describeTable(),
      findTableSchema: this.findTableSchema(),
      getCurrentActiveQueries: this.getCurrentActiveQueries(),
      getQueriesWaitingOnLocks: this.getQueriesWaitingOnLocks(),
      getVacuumStats: this.getVacuumStats(),
      getConnectionsStats: this.getConnectionsStats(),
      getConnectionsGroups: this.getConnectionsGroups(),
      getPerformanceAndVacuumSettings: this.getPerformanceAndVacuumSettings()
    };
  }

  getSlowQueries(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get a list of slow queries formatted as a JSON array. Contains how many times the query was called,
the max execution time in seconds, the mean execution time in seconds, the total execution time
(all calls together) in seconds, the query itself, and the queryid for use with safeExplainQuery.`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run((client) => toolGetSlowQueries(client, 2000));
        } catch (error) {
          return `Error getting slow queries: ${error}`;
        }
      }
    });
  }

  unsafeExplainQuery(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Run EXPLAIN on a query you supply. The agent is in a read-only transaction, so EXPLAIN (without ANALYZE) never executes the query.
The query needs to be complete, it cannot contain $1, $2, etc. If you need to, replace the parameters with your own made up values.
It's very important that $1, $2, etc. are not passed to this tool. Use the tool describeTable to get the types of the columns.
If you know the schema, pass it in as well.`,
      parameters: z.object({
        schema: z.string(),
        query: z.string()
      }),
      execute: async ({ schema = 'public', query }) => {
        try {
          const explain = await run((client) => toolUnsafeExplainQuery(client, schema, query));
          if (!explain) return 'Could not run EXPLAIN on the query';
          return explain;
        } catch (error) {
          return `Error running EXPLAIN on the query: ${error}`;
        }
      }
    });
  }

  safeExplainQuery(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Safely run EXPLAIN on a query by fetching it from pg_stat_statements using queryId.
This prevents SQL injection by not accepting raw SQL queries. Returns the explain plan as received from PostgreSQL.
Use the queryid field from the getSlowQueries tool output as the queryId parameter.`,
      parameters: z.object({
        schema: z.string(),
        queryId: z.string().describe('The query ID from pg_stat_statements (use the queryid field from getSlowQueries)')
      }),
      execute: async ({ schema = 'public', queryId }) => {
        try {
          return await run((client) => toolSafeExplainQuery(client, schema, queryId));
        } catch (error) {
          return `Error running safe EXPLAIN on the query: ${error}`;
        }
      }
    });
  }

  describeTable(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Describe a table. If you know the schema, pass it as a parameter. If you don't, use public.`,
      parameters: z.object({
        schema: z.string(),
        table: z.string()
      }),
      execute: async ({ schema = 'public', table }) => {
        try {
          return await run((client) => toolDescribeTable(client, schema, table));
        } catch (error) {
          return `Error describing table: ${error}`;
        }
      }
    });
  }

  findTableSchema(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Find the schema of a table. Use this tool to find the schema of a table.`,
      parameters: z.object({
        table: z.string()
      }),
      execute: async ({ table }) => {
        try {
          return await run((client) => toolFindTableSchema(client, table));
        } catch (error) {
          return `Error finding table schema: ${error}`;
        }
      }
    });
  }

  getCurrentActiveQueries(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get the currently active queries.`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run(toolCurrentActiveQueries);
        } catch (error) {
          return `Error getting current active queries: ${error}`;
        }
      }
    });
  }

  getQueriesWaitingOnLocks(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get the queries that are currently blocked waiting on locks.`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run(toolGetQueriesWaitingOnLocks);
        } catch (error) {
          return `Error getting queries waiting on locks: ${error}`;
        }
      }
    });
  }

  getVacuumStats(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get the vacuum stats for the top tables in the database. They are sorted by the number of dead tuples descending.`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run(toolGetVacuumStats);
        } catch (error) {
          return `Error getting vacuum stats: ${error}`;
        }
      }
    });
  }

  getConnectionsStats(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get the connections stats for the database.`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run(toolGetConnectionsStats);
        } catch (error) {
          return `Error getting connections stats: ${error}`;
        }
      }
    });
  }

  getConnectionsGroups(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get the connections groups for the database. This is a view in the pg_stat_activity table, grouped by (state, user, application_name, client_addr, wait_event_type, wait_event).`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run(toolGetConnectionsGroups);
        } catch (error) {
          return `Error getting connections groups: ${error}`;
        }
      }
    });
  }

  getPerformanceAndVacuumSettings(): Tool {
    const run = this.run.bind(this);
    return tool({
      description: `Get the performance and vacuum settings for the database.`,
      parameters: z.object({}),
      execute: async () => {
        try {
          return await run(getPerformanceAndVacuumSettings);
        } catch (error) {
          return `Error getting performance and vacuum settings: ${error}`;
        }
      }
    });
  }
}
