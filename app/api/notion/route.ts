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

// Funkcja rekurencyjna do zebrania wszystkich podzadań wg relacji Parent item
function collectSubTasks(allTasks: Task[], parentId: string): Task[] {
  const directSubs = allTasks.filter(t => t.parentIds.includes(parentId));
  let allSubs: Task[] = [...directSubs];
  for (const sub of directSubs) {
    allSubs = allSubs.concat(collectSubTasks(allTasks, sub.id));
  }
  return allSubs;
}

export async function GET(req: NextRequest) {
  try {
    const masterDbUrl = process.env.NOTION_MASTER_DB_URL;
    if (!masterDbUrl) {
      return NextResponse.json({ error: 'NOTION_MASTER_DB_URL not set' }, { status: 500 });
    }

    // Pobierz ID bazy nadrzędnej z URL
    const url = new URL(masterDbUrl);
    const pathParts = url.pathname.split('/');
    const masterDbId = pathParts[pathParts.length - 1];

    // Pobierz listę rekordów z bazy nadrzędnej (bazy podrzędne)
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

      // Pobierz nazwę zadania nadrzędnego (bazy)
      const baseName = safeGetText(props['Nazwa bazy'] || props['Name'] || props['name']);
      if (!baseName) continue;

      // Pobierz link do bazy podrzędnej
      const dbLink = safeGetText(props['Link do bazy']);
      if (!dbLink) continue;

      // Wyciągnij ID bazy podrzędnej z linku
      let dbId: string | null = null;
      try {
        const dbUrl = new URL(dbLink);
        const parts = dbUrl.pathname.split('/');
        dbId = parts[parts.length - 1];
      } catch {
        continue;
      }
      if (!dbId) continue;

      // Pobierz taski z bazy podrzędnej
      const dbQuery = await notion.databases.query({
        database_id: dbId,
        page_size: 100,
      });

      // Zmapuj taski na obiekty Task
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

      // Wybierz zadania nadrzędne - takie, które nie są sub-taskami lub mają puste parentIds
      const rootTasks = allTasks.filter(t => !t.isSubTask || t.parentIds.length === 0);

      // Twórz wykresy wg każdego root taska z uwzględnieniem sub-tasków
      for (const rootTask of rootTasks) {
        const subTasks = collectSubTasks(allTasks, rootTask.id);

        // Do wykresu wrzucamy zadania rootTask + wszystkie subtaski pod nim
        const relevantTasks = [rootTask, ...subTasks];

        // Grupowanie po statusach
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
          slot: null, // jeśli masz gdzieś slot to tu go możesz podpiąć
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
    console.error(error);
    return NextResponse.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
}
