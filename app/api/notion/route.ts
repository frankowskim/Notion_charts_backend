import { NextRequest, NextResponse } from 'next/server';
import { Client, PageObjectResponse } from '@notionhq/client';

// Typy na dane frontend
interface ChartData {
  label: string;
  value: number;
}

interface ChartItem {
  title: string;
  slot: number | null;
  data: ChartData[];
}

function extractDatabaseId(notionUrl: string): string | null {
  const regex = /([0-9a-f]{32})/i;
  const match = notionUrl.match(regex);
  if (!match) return null;
  return match[1].replace(
    /([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})/,
    '$1-$2-$3-$4-$5'
  );
}

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

async function fetchDatabaseItems(databaseId: string): Promise<ChartItem[]> {
  const results: ChartItem[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      // Weryfikacja, czy page jest pełnym PageObjectResponse z properties
      if (page.object !== 'page') continue;
      if (!('properties' in page)) continue;

      const pageFull = page as PageObjectResponse;

      const props = pageFull.properties;

      // Title (pole "Name")
      let title = '';
      const titleProp = props['Name'];
      if (titleProp?.type === 'title') {
        title = titleProp.title.map((t: { plain_text: string }) => t.plain_text).join(' ');
      }

      // Slot - number lub select
      let slot: number | null = null;
      const slotProp = props['Slot'];
      if (slotProp?.type === 'number' && typeof slotProp.number === 'number') {
        slot = slotProp.number;
      } else if (slotProp?.type === 'select' && slotProp.select?.name) {
        const parsed = parseInt(slotProp.select.name, 10);
        slot = isNaN(parsed) ? null : parsed;
      }

      // Data - rich_text JSON
      let data: ChartData[] = [];
      const dataProp = props['Data'];
      if (dataProp?.type === 'rich_text' && dataProp.rich_text.length > 0) {
        try {
          const jsonText = dataProp.rich_text.map((t: { plain_text: string }) => t.plain_text).join('');
          const parsedData = JSON.parse(jsonText);
          if (Array.isArray(parsedData)) {
            data = parsedData
              .filter((item: any) => item.label && typeof item.value === 'number')
              .map((item: any) => ({
                label: String(item.label),
                value: Number(item.value),
              }));
          }
        } catch {
          // Ignoruj jeśli JSON niepoprawny
        }
      }

      results.push({
        title,
        slot,
        data,
      });
    }

    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return results;
}

export async function GET(req: NextRequest) {
  try {
    const notionDbLinks = process.env.NOTION_DB_LINKS;
    if (!notionDbLinks) {
      return NextResponse.json({ error: 'Brak NOTION_DB_LINKS w zmiennych środowiskowych' }, { status: 500 });
    }

    const dbUrls = notionDbLinks.split(',').map(s => s.trim()).filter(Boolean);
    if (dbUrls.length === 0) {
      return NextResponse.json({ error: 'NOTION_DB_LINKS jest puste' }, { status: 500 });
    }

    const allCharts: ChartItem[] = [];
    for (const dbUrl of dbUrls) {
      const dbId = extractDatabaseId(dbUrl);
      if (!dbId) continue;

      const items = await fetchDatabaseItems(dbId);

      // Prefix bazy w tytule wykresu
      const dbName = dbUrl.split('/').pop()?.slice(0, 6) ?? dbId.slice(0, 6);

      items.forEach(item => {
        const newTitle = item.title ? `${dbName}::${item.title}` : `${dbName}::Unnamed`;
        allCharts.push({ ...item, title: newTitle });
      });
    }

    return NextResponse.json({ charts: allCharts });
  } catch (error) {
    console.error('Błąd backendu:', error);
    return NextResponse.json({ error: (error as Error).message ?? 'Nieznany błąd' }, { status: 500 });
  }
}
