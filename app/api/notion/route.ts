import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function safeGetString(prop: any): string {
  if (!prop) return '';
  if ('title' in prop && prop.title.length > 0) {
    return prop.title.map((t: any) => t.plain_text).join('');
  }
  if ('rich_text' in prop && prop.rich_text.length > 0) {
    return prop.rich_text.map((t: any) => t.plain_text).join('');
  }
  if (typeof prop === 'string') return prop;
  return '';
}

function safeGetCheckbox(prop: any): boolean {
  if (!prop) return false;
  if ('checkbox' in prop) return prop.checkbox;
  return false;
}

function safeGetRelationIds(prop: any): string[] {
  if (!prop) return [];
  if ('relation' in prop && Array.isArray(prop.relation)) {
    return prop.relation.map((rel: any) => rel.id);
  }
  return [];
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const masterDbUrl = process.env.NOTION_MASTER_DB_URL;
    if (!masterDbUrl) throw new Error('NOTION_MASTER_DB_URL not set');

    const url = new URL(masterDbUrl);
    const pathnameParts = url.pathname.split('/');
    const masterDbId = pathnameParts[pathnameParts.length - 1];

    const masterDbResults = await notion.databases.query({
      database_id: masterDbId,
      filter: {
        property: 'Aktywna',
        checkbox: { equals: true },
      },
      sorts: [
        {
          property: 'Nazwa bazy',
          direction: 'ascending',
        },
      ],
      page_size: 100,
    });

    type Task = {
      id: string;
      title: string;
      status: string;
      isSubTask: boolean;
      parentIds: string[]; // relacja Parent item
    };

    const charts = [];

    for (const page of masterDbResults.results) {
      if (page.object !== 'page' || !('properties' in page)) continue;
      const properties = (page as any).properties;
      const baseName = safeGetString(properties['Nazwa bazy']);
      const dbLink = safeGetString(properties['Link do bazy']);
      if (!dbLink) continue;

      let dbId: string | null = null;
      try {
        const dbUrl = new URL(dbLink);
        const pathParts = dbUrl.pathname.split('/');
        dbId = pathParts[pathParts.length - 1];
      } catch {
        continue;
      }
      if (!dbId) continue;

      const dbQuery = await notion.databases.query({
        database_id: dbId,
        page_size: 100,
      });

      // Zmapuj taski z bazy podrzędnej
      const tasks: Task[] = [];

      for (const taskPage of dbQuery.results) {
        if (taskPage.object !== 'page' || !('properties' in taskPage)) continue;
        const props = (taskPage as any).properties;

        const title = safeGetString(props['Nazwa rekordu']);

        let status = '';
        if (
          props['status rekordu'] &&
          'select' in props['status rekordu'] &&
          props['status rekordu'].select
        ) {
          status = props['status rekordu'].select.name;
        }

        const isSubTask = safeGetCheckbox(props['IsSubTask']);
        const parentIds = safeGetRelationIds(props['Parent item']);

        tasks.push({
          id: taskPage.id,
          title,
          status,
          isSubTask,
          parentIds,
        });
      }

      // Wybierz nadrzędne taski (IsSubTask === false)
      const parentTasks = tasks.filter((t) => !t.isSubTask);

      for (const parent of parentTasks) {
        // Znajdź subtaski które mają w relacji parentIds id nadrzędnego zadania
        const subtasks = tasks.filter(
          (t) => t.isSubTask && t.parentIds.includes(parent.id)
        );

        // Zsumuj statusy nadrzędnego + subtasków
        const statusCounts: Record<string, number> = {
          'Not started': 0,
          Await: 0,
          'In progress': 0,
          Done: 0,
        };

        const allTasks = [parent, ...subtasks];

        for (const task of allTasks) {
          if (statusCounts[task.status] !== undefined) {
            statusCounts[task.status]++;
          }
        }

        const chartTitle = `${baseName}::${parent.title}`;

        const data = Object.entries(statusCounts).map(([label, value]) => ({
          label,
          value,
        }));

        charts.push({
          title: chartTitle,
          slot: null,
          data,
        });
      }
    }

    const headers = new Headers({
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });

    return new Response(JSON.stringify({ charts }), { status: 200, headers });
  } catch (error) {
    console.error('Błąd API:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'Unknown error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
}
