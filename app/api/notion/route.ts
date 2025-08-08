import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import {
  QueryDatabaseParameters,
  PageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';

// Typ dla elementów w Master DB
interface MasterDBItem {
  id: string;
  name: string;
  databaseId: string;
  active: boolean;
}

// Typ dla pojedynczego wpisu wykresu
interface ChartItem {
  id: string;
  title: string;
  slot: string | null;
  value: number | null;
}

// Typ dla odpowiedzi backendu
interface ChartsGroupedResponse {
  databaseName: string;
  items: ChartItem[];
}

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const MASTER_DB_ID = process.env.NOTION_MASTER_DB_ID;

// Walidacja zmiennych środowiskowych z nadaniem typu string
if (!NOTION_API_KEY) {
  throw new Error('Brak NOTION_API_KEY w zmiennych środowiskowych');
}
if (!MASTER_DB_ID) {
  throw new Error('Brak NOTION_MASTER_DB_ID w zmiennych środowiskowych');
}

const notion = new Client({ auth: NOTION_API_KEY as string });

// Funkcja pobierająca wszystkie strony z dowolnej bazy
async function getAllPages(databaseId: string): Promise<PageObjectResponse[]> {
  let cursor: string | undefined = undefined;
  const pages: PageObjectResponse[] = [];

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });

    // Filtrujemy, aby zostały tylko pełne PageObjectResponse
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
  const pages = await getAllPages(MASTER_DB_ID as string);

  return pages
    .map((page) => {
      const nameProp = page.properties['Name'];
      const dbIdProp = page.properties['Database ID'];
      const activeProp = page.properties['Active'];

      return {
        id: page.id,
        name:
          nameProp.type === 'title'
            ? nameProp.title.map((t) => t.plain_text).join('')
            : '',
        databaseId:
          dbIdProp.type === 'rich_text'
            ? dbIdProp.rich_text.map((t) => t.plain_text).join('')
            : '',
        active:
          activeProp.type === 'checkbox' ? activeProp.checkbox : false,
      } as MasterDBItem;
    })
    .filter((db) => !!db.databaseId && db.active);
}

// Pobranie danych z wybranej bazy
async function getChartData(databaseId: string): Promise<ChartItem[]> {
  const pages = await getAllPages(databaseId);

  return pages.map((page) => {
    const titleProp = page.properties['Name'];
    const slotProp = page.properties['Slot'];
    const valueProp = page.properties['Value'];

    const title =
      titleProp.type === 'title'
        ? titleProp.title.map((t) => t.plain_text).join('')
        : '';

    const slot =
      slotProp.type === 'select' ? slotProp.select?.name ?? null : null;

    const value =
      valueProp.type === 'number' ? valueProp.number : null;

    return {
      id: page.id,
      title,
      slot,
      value,
    };
  });
}

// Handler GET
export async function GET() {
  try {
    const databases = await getDatabasesFromMaster();

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
