import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

interface Task {
  id: string;
  title: string;
  status: string;
  parentIds: string[];
  isSubTask: boolean;
}

function safeGetText(prop: any): string {
  if (!prop) return '';
  if (prop.type === 'title' && Array.isArray(prop.title)) {
    return prop.title.map((t: any) => t.plain_text).join('');
  }
  if (prop.type === 'rich_text' && Array.isArray(prop.rich_text)) {
    return prop.rich_text.map((t: any) => t.plain_text).join('');
  }
  if (typeof prop === 'string') return prop;
  return '';
}

function safeGetSelect(prop: any): string {
  if (!prop || !prop.select) return '';
  return prop.select.name || '';
}

function safeGetCheckbox(prop: any): boolean {
  if (!prop) return false;
  if (typeof prop.checkbox === 'boolean') return prop.checkbox;
  return false;
}

function safeGetRelationIds(prop: any): string[] {
  if (!prop || !Array.isArray(prop.relation)) return [];
  return prop.relation.map((rel: any) => rel.id);
}

function collectSubTasks(allTasks: Task[], parentId: string): Task[] {
  const directSubs = allTasks.filter(t => t.parentIds.includes(parentId));
  let allSubs: Task[] = [...directSubs];
  for (const sub of directSubs) {
    allSubs = allSubs.concat(collectSubTasks(allTasks, sub.id));
  }
  return allSubs;
}

function extractNotionIdFromUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    // Ścieżka np. /Workspace/Name-dbUUID
    const parts = url.pathname.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      // Usuwamy wszystko, co nie jest heksadecymalnym UUID (z kreskami)
      const cleaned = part.replace(/[^0-9a-fA-F-]/g, '');
      if (/^[0-9a-fA-F]{32}$/.test(cleaned.replace(/-/g, '')) || /^[0-9a-fA-F-]{36}$/.test(cleaned)) {
        return cleaned;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const masterDbUrl = process.env.NOTION_MASTER_DB_URL;
    if (!masterDbUrl) {
      return NextResponse.json({ error: 'NOTION_MASTER_DB_URL env var is missing' }, { status: 500 });
    }

    const masterDbId = extractNotionIdFromUrl(masterDbUrl);
    if (!masterDbId) {
      return NextResponse.json({ error: 'Cannot extract Notion DB ID from NOTION_MASTER_DB_URL' }, { status: 500 });
    }

    // Pobierz rekordy z bazy nadrzędnej
    const masterDbResults = await notion.databases.query({
      database_id: masterDbId,
      page_size: 100,
      filter: {
        property: 'Aktywna',
        checkbox: {
          equals: true,
        },
      },
    });

    const charts = [];

    for (const masterPage of masterDbResults.results) {
      if (masterPage.object !== 'page' || !('properties' in masterPage)) continue;
      const props = (masterPage as any).properties;

      const baseName = safeGetText(props['Nazwa bazy'] || props['Name'] || props['name']);
      if (!baseName) continue;

      const dbLink = safeGetText(props['Link do bazy']);
      if (!dbLink) continue;

      const dbId = extractNotionIdFromUrl(dbLink);
      if (!dbId) continue;

      // Pobierz taski z bazy podrzędnej
      const dbQuery = await notion.databases.query({
        database_id: dbId,
        page_size: 100,
      });

      const allTasks: Task[] = [];
      for (const taskPage of dbQuery.results) {
        if (taskPage.object !== 'page' || !('properties' in taskPage)) continue;
        const taskProps = (taskPage as any).properties;

        const title = safeGetText(taskProps['Name']);
        if (!title) continue;

        const status = safeGetSelect(taskProps['Status']);
        const isSubTask = safeGetCheckbox(taskProps['IsSubTask']);
        const parentIds = safeGetRelationIds(taskProps['Parent item']);

        allTasks.push({
          id: taskPage.id,
          title,
          status,
          isSubTask,
          parentIds,
        });
      }

      const rootTasks = allTasks.filter(t => !t.isSubTask || t.parentIds.length === 0);

      for (const rootTask of rootTasks) {
        const subTasks = collectSubTasks(allTasks, rootTask.id);
        const relevantTasks = [rootTask, ...subTasks];

        const statusMap = new Map<string, number>();
        for (const t of relevantTasks) {
          statusMap.set(t.status, (statusMap.get(t.status) || 0) + 1);
        }

        const data = Array.from(statusMap.entries()).map(([label, value]) => ({
          label,
          value,
        }));

        charts.push({
          title: `${baseName} - ${rootTask.title}`,
          slot: null,
          data,
        });
      }
    }

    const response = NextResponse.json({ charts });
    response.headers.append('Access-Control-Allow-Origin', '*');
    response.headers.append('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.headers.append('Access-Control-Allow-Headers', 'Content-Type');

    return response;
  } catch (error: any) {
    console.error('Error in API:', error);
    return NextResponse.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
}
