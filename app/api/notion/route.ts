import { NextResponse } from 'next/server';
import { Client, PageObjectResponse } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function convertUrlToId(url: string): string {
  const regex = /([0-9a-f]{32})/;
  const match = url.match(regex);
  if (!match) throw new Error('Invalid Notion database URL');
  const id = match[1];
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

interface ChartDataPoint {
  label: string;
  value: number;
}

interface ChartItem {
  title: string;  // format: "NazwaBazy::Slot X"
  slot: number | null;
  data: ChartDataPoint[];
}

export async function GET() {
  const masterDbUrl = process.env.NOTION_MASTER_DB_URL;
  if (!masterDbUrl) {
    return NextResponse.json({ error: 'Missing NOTION_MASTER_DB_URL environment variable' }, { status: 500 });
  }

  let masterDbId: string;
  try {
    masterDbId = convertUrlToId(masterDbUrl);
  } catch (error) {
    return NextResponse.json({ error: 'Invalid NOTION_MASTER_DB_URL format' }, { status: 500 });
  }

  // Pobierz aktywne bazy z master db
  let masterQuery;
  try {
    masterQuery = await notion.databases.query({
      database_id: masterDbId,
      filter: {
        property: 'Aktywna',
        checkbox: { equals: true }
      }
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to query master database' }, { status: 500 });
  }

  // Parsowanie aktywnych baz - filtrujemy tylko pełne PageObjectResponse z properties
  const activeBases = masterQuery.results
    .filter((page): page is PageObjectResponse => 'properties' in page)
    .map(page => {
      const props = page.properties;

      // Nazwa bazy (tekst)
      const baseNameProp = props['Nazwa bazy'];
      let baseName = '';
      if (baseNameProp?.type === 'title' && baseNameProp.title.length > 0) {
        baseName = baseNameProp.title[0].plain_text;
      }

      // Link do bazy (url)
      const baseUrlProp = props['Link do bazy'];
      let baseUrl: string | undefined;
      if (baseUrlProp?.type === 'url') {
        baseUrl = baseUrlProp.url ?? undefined;
      }

      if (!baseName || !baseUrl) return null;

      try {
        const baseId = convertUrlToId(baseUrl);
        return { baseName, baseId };
      } catch {
        return null;
      }
    })
    .filter((v): v is { baseName: string; baseId: string } => v !== null);

  const charts: ChartItem[] = [];

  for (const base of activeBases) {
    const dbId = base.baseId;

    // Pobierz wszystkie strony (zadania) z bazy
    let allTasks: PageObjectResponse[] = [];
    let cursor: string | undefined = undefined;
    try {
      do {
        const response = await notion.databases.query({
          database_id: dbId,
          start_cursor: cursor,
          page_size: 100
        });
        const pages = response.results.filter((page): page is PageObjectResponse => 'properties' in page);
        allTasks = allTasks.concat(pages);
        cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
      } while (cursor);
    } catch (error) {
      // Pomiń tę bazę, jeśli błąd pobierania
      continue;
    }

    // Grupuj dane wg slot i status
    // Zakładamy, że:
    // - Slot to właściwość typu number
    // - Status to właściwość typu select (nazwy statusów: Not started, Await, In progress, Done)

    const slotStatusMap = new Map<number | null, Map<string, number>>();

    for (const task of allTasks) {
      const props = task.properties;

      // Pobierz slot (number) lub null
      let slot: number | null = null;
      const slotProp = props['Slot'];
      if (slotProp?.type === 'number') {
        slot = slotProp.number ?? null;
      }

      // Pobierz status (select.name) lub 'Not started' jako domyślne
      let status = 'Not started';
      const statusProp = props['Status'];
      if (statusProp?.type === 'select' && statusProp.select) {
        status = statusProp.select.name;
      }

      if (!slotStatusMap.has(slot)) slotStatusMap.set(slot, new Map());

      const statusMap = slotStatusMap.get(slot)!;
      statusMap.set(status, (statusMap.get(status) ?? 0) + 1);
    }

    // Przygotuj charty
    for (const [slot, statusMap] of slotStatusMap.entries()) {
      const allStatuses = ['Not started', 'Await', 'In progress', 'Done'];
      const data: ChartDataPoint[] = allStatuses.map(s => ({
        label: s,
        value: statusMap.get(s) ?? 0
      }));

      charts.push({
        title: `${base.baseName}::Slot ${slot === null ? 'null' : slot}`,
        slot,
        data
      });
    }
  }

  // Sortuj wg nazwy bazy i slotu
  charts.sort((a, b) => {
    const [baseA, slotA] = a.title.split('::');
    const [baseB, slotB] = b.title.split('::');

    if (baseA !== baseB) return baseA.localeCompare(baseB);

    // Slot może być "null" lub "Slot X"
    const slotANum = a.slot ?? -1;
    const slotBNum = b.slot ?? -1;

    return slotANum - slotBNum;
  });

  return NextResponse.json({ charts });
}
