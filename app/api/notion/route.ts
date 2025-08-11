import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import type { PageObjectResponse, QueryDatabaseParameters } from '@notionhq/client/build/src/api-endpoints';

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
  title: string; // "NazwaBazy::NazwaRodzica"
  slot: number | null;
  data: ChartDataPoint[];
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_MASTER_DB_URL = process.env.NOTION_MASTER_DB_URL;

if (!NOTION_TOKEN) throw new Error('Brak NOTION_TOKEN w zmiennych środowiskowych');
if (!NOTION_MASTER_DB_URL) throw new Error('Brak NOTION_MASTER_DB_URL w zmiennych środowiskowych');

function extractDatabaseIdFromUrl(url: string): string {
  const cleanUrl = url.split('?')[0];
  const match = cleanUrl.match(/([0-9a-fA-F]{32}|[0-9a-fA-F\-]{36})$/);
  if (!match) throw new Error(`Nie znaleziono ID bazy w adresie: ${url}`);
  return match[0].replace(/-/g, '');
}

const MASTER_DB_ID = extractDatabaseIdFromUrl(NOTION_MASTER_DB_URL);
const notion = new Client({ auth: NOTION_TOKEN });

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

function getSlot(page: PageObjectResponse): number | null {
  const slotProp = page.properties['Slot'];
  if (!slotProp) return null;

  if (slotProp.type === 'select' && slotProp.select?.name) {
    const num = parseInt(slotProp.select.name, 10);
    return isNaN(num) ? null : num;
  }

  if (slotProp.type === 'number' && typeof slotProp.number === 'number') {
    return slotProp.number;
  }

  return null;
}

function getStatus(page: PageObjectResponse): string {
  const statusProp = page.properties['Status'];
  if (!statusProp) return 'Brak statusu';

  if (statusProp.type === 'select' && statusProp.select?.name) {
    return statusProp.select.name;
  }

  if (statusProp.type === 'multi_select' && statusProp.multi_select.length > 0) {
    return statusProp.multi_select.map(s => s.name).join(', ');
  }

  if (statusProp.type === 'rich_text' && statusProp.rich_text.length > 0) {
    return statusProp.rich_text.map(t => t.plain_text).join('') || 'Brak statusu';
  }

  return 'Brak statusu';
}

async function getChartData(databaseId: string, databaseName: string): Promise<ChartItem[]> {
  const pages = await getAllPages(databaseId);

  // Mapa id rodziców (zadań nadrzędnych) na ich tytuł i slot
  const parentMap: Record<string, { title: string; slot: number }> = {};

  for (const page of pages) {
    const slot = getSlot(page);
    if (slot === null) continue;

    // Sprawdzamy, czy to rodzic - ma podzadania (#Children liczba większa od 0)
    const childrenProp = page.properties['#Children'];
    const isParent = childrenProp && childrenProp.type === 'number' && childrenProp.number && childrenProp.number > 0;

    if (isParent) {
      parentMap[page.id] = {
        title: `${databaseName}::${getTitle(page)}`,
        slot,
      };
    }
  }

  // Zliczamy zadania wg slotu i statusu
  // Ignorujemy podzadania (te które mają rodzica)
  const slotStatusCount: Record<number, Record<string, number>> = {};

  for (const page of pages) {
    // Jeśli zadanie ma rodzica, pomijamy (liczymy tylko zadania główne)
    const parentProp = page.properties['Parent item'];
    if (parentProp && parentProp.type === 'relation' && parentProp.relation.length > 0) {
      continue;
    }

    const slot = getSlot(page);
    if (slot === null) continue;

    const status = getStatus(page);

    if (!slotStatusCount[slot]) slotStatusCount[slot] = {};
    if (!slotStatusCount[slot][status]) slotStatusCount[slot][status] = 0;
    slotStatusCount[slot][status]++;
  }

  const charts: ChartItem[] = [];

  for (const [slotStr, statusCounts] of Object.entries(slotStatusCount)) {
    const slot = parseInt(slotStr, 10);

    // Znajdź tytuł rodzica dla slotu lub fallback
    const parentEntry = Object.values(parentMap).find(p => p.slot === slot);

    const title = parentEntry ? parentEntry.title : `Slot ${slot}`;

    const data: ChartDataPoint[] = Object.entries(statusCounts).map(([label, value]) => ({
      label,
      value,
    }));

    charts.push({
      title,
      slot,
      data,
    });
  }

  // Sortuj po slotach rosnąco
  return charts.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://notioncharts.netlify.app',
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
    console.error('Backend error:', error);
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
