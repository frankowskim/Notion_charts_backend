import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import { QueryDatabaseParameters, PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

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

      const name =
        nameProp && nameProp.type === 'rich_text'
          ? nameProp.rich_text.map((t) => t.plain_text).join('')
          : '';

      const url =
        urlProp && urlProp.type === 'url'
          ? urlProp.url ?? ''
          : '';

      const databaseId = url ? extractDatabaseIdFromUrl(url) : '';

      const active = activeProp && activeProp.type === 'checkbox' ? activeProp.checkbox : false;

      return {
        id: page.id,
        name,
        databaseId,
        active,
      } as MasterDBItem;
    })
    .filter((db) => !!db.databaseId && db.active);
}

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

// Nagłówki CORS
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://notioncharts.netlify.app',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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

    return new NextResponse(JSON.stringify(results), {
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
