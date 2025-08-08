import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import { QueryDatabaseParameters, PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

interface MasterDBItem {
  id: string;
  name: string;
  databaseId: string;
  active: boolean;
}

interface ChartDataPoint {
  label: string;
  value: number;
}

interface ChartItem {
  title: string; // "NazwaBazy::NazwaWykresu"
  slot: number | null;
  data: ChartDataPoint[];
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_MASTER_DB_URL = process.env.NOTION_MASTER_DB_URL;

if (!NOTION_TOKEN) {
  throw new Error('Brak NOTION_TOKEN w zmiennych środowiskowych');
}
if (!NOTION_MASTER_DB_URL) {
  throw new Error('Brak NOTION_MASTER_DB_URL w zmiennych środowiskowych');
}

function extractDatabaseIdFromUrl(url: string): string {
  try {
    const cleanUrl = url.split('?')[0];
    const match = cleanUrl.match(/([0-9a-fA-F]{32}|[0-9a-fA-F\-]{36})$/);
    if (!match) {
      throw new Error(`Nie znaleziono ID bazy w adresie: ${url}`);
    }
    return match[0].replace(/-/g, '');
  } catch {
    throw new Error('Nie udało się wyciągnąć ID bazy z NOTION_MASTER_DB_URL');
  }
}

const MASTER_DB_ID = extractDatabaseIdFromUrl(NOTION_MASTER_DB_URL);
const notion = new Client({ auth: NOTION_TOKEN as string });

async function getAllPages(databaseId: string): Promise<PageObjectResponse[]> {
  let cursor: string | undefined = undefined;
  const pages: PageObjectResponse[] = [];

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    } as QueryDatabaseParameters);

    const fullPages = response.results.filter(
      (p): p is PageObjectResponse => 'properties' in p
    );

    pages.push(...fullPages);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

async function getDatabasesFromMaster(): Promise<MasterDBItem[]> {
  const pages = await getAllPages(MASTER_DB_ID);

  return pages
    .map((page) => {
      const props = page.properties;

      const nameProp = props['Nazwa bazy'];
      const urlProp = props['Link do bazy'];
      const activeProp = props['Aktywna'];

      let name = '';
      if (nameProp) {
        if (nameProp.type === 'title' && Array.isArray(nameProp.title)) {
          name = nameProp.title.map(t => t.plain_text).join('');
        } else if (nameProp.type === 'rich_text' && Array.isArray(nameProp.rich_text)) {
          name = nameProp.rich_text.map(t => t.plain_text).join('');
        }
      }

      let url = '';
      if (urlProp && urlProp.type === 'url') {
        url = urlProp.url ?? '';
      }

      const databaseId = url ? extractDatabaseIdFromUrl(url) : '';

      let active = false;
      if (activeProp && activeProp.type === 'checkbox') {
        active = activeProp.checkbox;
      }

      return {
        id: page.id,
        name,
        databaseId,
        active,
      } as MasterDBItem;
    })
    .filter((db) => !!db.databaseId && db.active);
}

function getTitle(page: PageObjectResponse): string {
  const titleProp = page.properties['Name'];
  if (titleProp && titleProp.type === 'title') {
    return titleProp.title.map(t => t.plain_text).join('');
  }
  return '';
}

function getValue(page: PageObjectResponse): number | null {
  const valueProp = page.properties['Value'];
  if (valueProp && valueProp.type === 'number' && valueProp.number !== null) {
    return valueProp.number;
  }
  return null;
}

function getSlotNumber(page: PageObjectResponse): number | null {
  const slotProp = page.properties['Slot'];
  if (slotProp && slotProp.type === 'select' && slotProp.select?.name) {
    const num = parseInt(slotProp.select.name, 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

function getParentId(page: PageObjectResponse): string | null {
  const parentProp = page.properties['Parent item'];
  if (parentProp && parentProp.type === 'relation' && parentProp.relation.length > 0) {
    return parentProp.relation[0].id;
  }
  return null;
}

async function getChartData(databaseId: string, databaseName: string): Promise<ChartItem[]> {
  const pages = await getAllPages(databaseId);

  // Rodzice to te, które mają slot ustawiony
  const parents = pages.filter(p => getSlotNumber(p) !== null);
  // Subtaski to te bez slotu
  const subtasks = pages.filter(p => getSlotNumber(p) === null);

  const parentsMap: Record<string, ChartItem> = {};

  for (const parent of parents) {
    const slot = getSlotNumber(parent);
    if (slot === null) continue;

    const title = getTitle(parent);

    parentsMap[parent.id] = {
      title: `${databaseName}::${title}`,
      slot,
      data: [],
    };

    // Dodaj wartość rodzica jako jeden punkt danych, jeśli jest dostępna
    const parentValue = getValue(parent);
    if (parentValue !== null) {
      parentsMap[parent.id].data.push({
        label: title || 'Brak nazwy',
        value: parentValue,
      });
    }
  }

  for (const subtask of subtasks) {
    const parentId = getParentId(subtask);
    if (!parentId || !parentsMap[parentId]) continue;

    const label = getTitle(subtask) || 'Podzadanie';

    const value = getValue(subtask);
    if (value !== null) {
      parentsMap[parentId].data.push({
        label,
        value,
      });
    } else {
      // Jeżeli nie ma wartości, można ustawić domyślną np. 1 (opcjonalne)
      // parentsMap[parentId].data.push({ label, value: 1 });
    }
  }

  // Jeśli któryś wykres (rodzic) ma pustą tablicę data (brak wartości),
  // żeby nie było pustych wykresów, dodaj dummy dane (opcjonalnie)
  for (const key in parentsMap) {
    if (parentsMap[key].data.length === 0) {
      parentsMap[key].data.push({
        label: 'Brak danych',
        value: 1,
      });
    }
  }

  return Object.values(parentsMap).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // na dev możesz zostawić '*', w produkcji daj konkretną domenę
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function GET() {
  try {
    const databases = await getDatabasesFromMaster();
    const allCharts: ChartItem[] = [];

    for (const db of databases) {
      if (!db.databaseId) continue;
      const charts = await getChartData(db.databaseId, db.name);
      allCharts.push(...charts);
    }

    return new NextResponse(JSON.stringify({ charts: allCharts }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error(error);
    return new NextResponse(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
      },
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
