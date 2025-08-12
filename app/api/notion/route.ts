import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

interface ChartDataPoint {
  label: string;
  value: number;
}

interface ChartItem {
  title: string; // np. "NazwaBazy::NazwaWykresu"
  slot: number | null;
  data: ChartDataPoint[];
}

interface ApiResponse {
  charts: ChartItem[];
}

function safeGetString(prop: any): string {
  // Funkcja bezpiecznego pobrania tekstu z Notion property (rich_text, title)
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

export async function OPTIONS() {
  // Obsługa preflight CORS
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
    // Link do master DB - to jest pełen URL w zmiennej
    const masterDbUrl = process.env.NOTION_MASTER_DB_URL;
    if (!masterDbUrl) throw new Error('NOTION_MASTER_DB_URL not set');

    // W Notion API nie pobieramy DB po URL, tylko po ID - więc musimy wyciągnąć DB ID z masterDbUrl
    // Zakładam, że masterDbUrl ma formę https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...
    // Wyciągamy część po "/" a przed "?" jako database ID
    const url = new URL(masterDbUrl);
    const pathnameParts = url.pathname.split('/');
    const masterDbId = pathnameParts[pathnameParts.length - 1];

    // Pobieramy rekordy z master DB, filtrowane po checkboxie "Aktywna"
    const masterDbResults = await notion.databases.query({
      database_id: masterDbId,
      filter: {
        property: 'Aktywna',
        checkbox: {
          equals: true,
        },
      },
      sorts: [
        {
          property: 'Nazwa bazy',
          direction: 'ascending',
        },
      ],
      page_size: 100,
    });

    // W master DB mamy kolumnę "Link do bazy" (URL do bazy, z której pobieramy dane)
    // Z niej wyciągamy DB ID analogicznie (ostatni fragment URL ścieżki)

    const charts: ChartItem[] = [];

    for (const page of masterDbResults.results) {
      if (page.object !== 'page' || !('properties' in page)) continue;

      const properties = (page as any).properties;
      const baseName = safeGetString(properties['Nazwa bazy']);
      const dbLink = safeGetString(properties['Link do bazy']); // powinien być URL tekstowo

      if (!dbLink) continue;

      // Wyciągamy DB ID z dbLink URL
      let dbId: string | null = null;
      try {
        const dbUrl = new URL(dbLink);
        const pathParts = dbUrl.pathname.split('/');
        dbId = pathParts[pathParts.length - 1];
      } catch {
        continue;
      }

      if (!dbId) continue;

      // Query do docelowej bazy danych
      const dbQuery = await notion.databases.query({
        database_id: dbId,
        page_size: 100,
      });

      // Mapujemy taski na strukturę:
      // slot - number | null
      // status - status zadania (tekst)
      // title - nazwa zadania
      // parent item - nazwa slotu (opcjonalnie)

      type Task = {
        slot: number | null;
        status: string;
        title: string;
      };

      // Parsujemy właściwości z bazy docelowej
      const tasks: Task[] = [];

      for (const taskPage of dbQuery.results) {
        if (taskPage.object !== 'page' || !('properties' in taskPage)) continue;
        const props = (taskPage as any).properties;

        // Pobierz slot - zakładam, że pole "Slot rekordu" jest typu number lub select/number
        let slot: number | null = null;
        if (props['Slot rekordu']) {
          const slotProp = props['Slot rekordu'];
          // Obsłuż różne typy - number, select, czy tekst
          if ('number' in slotProp && typeof slotProp.number === 'number') {
            slot = slotProp.number;
          } else if ('select' in slotProp && slotProp.select?.name) {
            const parsed = Number(slotProp.select.name);
            slot = isNaN(parsed) ? null : parsed;
          }
        }

        // Pobierz status - pole "status rekordu"
        let status = '';
        if (props['status rekordu'] && 'select' in props['status rekordu'] && props['status rekordu'].select) {
          status = props['status rekordu'].select.name;
        }

        // Pobierz tytuł - "Nazwa rekordu"
        let title = safeGetString(props['Nazwa rekordu']);

        tasks.push({ slot, status, title });
      }

      // Grupujemy zadania po slotach
      // Dla każdego slotu tworzymy chart z sumą statusów
      // slot null traktujemy jako podzadanie - ale w Twoim frontendzie tylko slot !== null tworzy wykres

      // Znajdź unikalne sloty, które są liczbami i !== null
      const uniqueSlots = Array.from(new Set(tasks.filter(t => t.slot !== null).map(t => t.slot as number))).sort((a,b) => a-b);

      for (const slotNum of uniqueSlots) {
        // Weź wszystkie zadania o tym slocie (slot === slotNum)
        const slotTasks = tasks.filter(t => t.slot === slotNum);

        // Zlicz statusy
        const statusCounts: Record<string, number> = {
          'Not started': 0,
          'Await': 0,
          'In progress': 0,
          'Done': 0,
        };

        for (const task of slotTasks) {
          if (statusCounts[task.status] !== undefined) {
            statusCounts[task.status]++;
          }
        }

        // Tworzymy tytuł wykresu: "NazwaBazy::Slot X" lub jeśli chcesz, możesz wziąć nazwę z zadania z tym slotem (np. tytuł pierwszego zadania)
        // Załóżmy, że bierzemy tytuł pierwszego zadania w tym slocie jako nazwa wykresu:
        const chartTitle = `${baseName}::Slot ${slotNum}`;

        const data: ChartDataPoint[] = Object.entries(statusCounts).map(([label, value]) => ({ label, value }));

        charts.push({
          title: chartTitle,
          slot: slotNum,
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
