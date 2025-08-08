import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import {
  QueryDatabaseParameters,
  PageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';

// Typy pozostają bez zmian

interface MasterDBItem {
  id: string;
  name: string;
  databaseId: string;
  active: boolean;
}

interface ChartItem {
  id: string;
  title: string;
  slot: string | null;
  value: number | null;
}

interface ChartsGroupedResponse {
  databaseName: string;
  items: ChartItem[];
}

// Zmienne środowiskowe
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_MASTER_DB_URL = process.env.NOTION_MASTER_DB_URL;

if (!NOTION_TOKEN) {
  throw new Error('Brak NOTION_TOKEN w zmiennych środowiskowych');
}
if (!NOTION_MASTER_DB_URL) {
  throw new Error('Brak NOTION_MASTER_DB_URL w zmiennych środowiskowych');
}

// Funkcja ekstrakcji ID bazy z pełnego URL Notion (usuwa myślniki)
function extractDatabaseIdFromUrl(url: string): string {
  try {
    const cleanUrl = url.split('?')[0]; // usuwamy parametry zapytania
    const match = cleanUrl.match(/([0-9a-fA-F]{32}|[0-9a-fA-F\-]{36})$/);
    if (!match) {
      throw new Error(`Nie znaleziono ID bazy w adresie: ${url}`);
    }
    return match[0].replace(/-/g, ''); // usuwamy myślniki
  } catch (err) {
    throw new Error('Nie udało się wyciągnąć ID bazy z NOTION_MASTER_DB_URL');
  }
}

const MASTER_DB_ID = extractDatabaseIdFromUrl(NOTION_MASTER_DB_URL);

const notion = new Client({ auth: NOTION_TOKEN as string });

// Funkcja pobierająca wszystkie strony z dowolnej bazy
async function getAllPages(databaseId: string): Promise<PageObjectResponse[]> {
  let cursor: string | undefined = undefined;
  const pages: PageObjectResponse[] = [];

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });

    const fullPages = response.results.filter(
      (p): p is PageObjectResponse => 'properties' in p
    );

    pages.push(...fullPages);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

// Pobranie listy baz z Master DB
async function getDatabasesFromMaster(): Promise<MasterDBItem[]> {
  const pages = await getAllPages(MASTER_DB_ID);

  return pages
    .map((page) => {
      const nameProp = page.properties?.['Name'];
      const dbIdProp = page.properties?.['Database ID'];
      const activeProp = page.properties?.['Active'];

      return {
        id: page.id,
        name:
          nameProp && nameProp.type === 'title'
            ? nameProp.title.map((t) => t.plain_text).join('')
            : '',
        databaseId:
          dbIdProp && dbIdProp.type === 'rich_text'
            ? dbIdProp.rich_text.map((t) => t.plain_text).join('')
            : '',
        active:
          activeProp && activeProp.type === 'checkbox' ? activeProp.checkbox : false,
      } as MasterDBItem;
    })
    .filter((db) => !!db.databaseId && db.active);
}

// Pobranie danych z wybranej bazy
async function getChartData(databaseId: string): Promise<ChartItem[]> {
  const pages = await getAllPages(databaseId);

  return pages.map((page) => {
    const titleProp = page.properties?.['Name'];
    const slotProp = page.properties?.['Slot'];
    const valueProp = page.properties?.['Value'];

    const title =
      titleProp && titleProp.type === 'title'
        ? titleProp.title.map((t) => t.plain_text).join('')
        : '';

    const slot =
      slotProp && slotProp.type === 'select' ? slotProp.select?.name ?? null : null;

    const value =
      valueProp && valueProp.type === 'number' ? valueProp.number : null;

    return {
      id: page.id,
      title,
      slot,
      value,
    };
  });
}

export async function GET() {
  try {
    const databases = await getDatabasesFromMaster();
console.log('Databases from master:', databases);
    const results: ChartsGroupedResponse[] = [];

    for (const db of databases) {
      if (!db.databaseId) continue;
      const items = await getChartData(db.databaseId);
      results.push({
        databaseName: db.name,
        items,
      });
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
