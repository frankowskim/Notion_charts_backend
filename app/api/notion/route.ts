import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';

const FRONTEND_URL = 'https://notioncharts.netlify.app';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// 🧠 Cache
let cache: any = null;
let lastFetchTime = 0;
const CACHE_DURATION = 1 * 1000; // 1 sekunda
let lastModifiedTimestamp = Date.now();

// Pomocnicza funkcja do porównania dwóch chartów (po title) i zwrócenia różnic w danych
function getChartDiff(oldChart: any, newChart: any) {
  if (!oldChart || !newChart) return null;
  const changes: Record<string, number> = {};
  for (const { label, value } of newChart.data) {
    const oldValue = oldChart.data.find((d: any) => d.label === label)?.value ?? 0;
    if (oldValue !== value) changes[label] = value;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

export async function GET() {
  // Zwróć dane z cache jeśli aktualne
  if (cache && Date.now() - lastFetchTime < CACHE_DURATION) {
    console.log("⚡️ Zwracam dane z cache");
    return NextResponse.json(cache, {
      headers: {
        'Access-Control-Allow-Origin': FRONTEND_URL,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'X-Last-Modified': lastModifiedTimestamp.toString(),
      },
    });
  }

  try {
    const databaseId = process.env.NOTION_DB_ID!;
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'Status',
        select: {
          is_not_empty: true
        }
      },
      page_size: 50,
    });

    const allTasks = response.results;
    const taskMap = new Map();

    allTasks.forEach((task: any) => {
      const id = task.id;
      const parentId = task.properties["Parent item"]?.relation?.[0]?.id || null;
      const isSubTask = !!parentId;
      const status = task.properties.Status?.select?.name || 'Brak';
      const title = task.properties.Name?.title?.[0]?.plain_text || 'Brak nazwy';
      const slotStr = task.properties.Slot?.select?.name || null;
      const slot = slotStr ? parseInt(slotStr, 10) : null;

      taskMap.set(id, {
        id,
        parentId,
        isSubTask,
        status,
        title,
        slot,
        children: [],
      });
    });

    // Budowanie struktury zagnieżdżonej
    taskMap.forEach(task => {
      if (task.parentId && taskMap.has(task.parentId)) {
        taskMap.get(task.parentId).children.push(task.id);
      }
    });

    function getDescendants(taskId: string): string[] {
      const descendants: string[] = [];
      const stack = [taskId];
      while (stack.length > 0) {
        const currentId = stack.pop();
        const currentTask = taskMap.get(currentId);
        if (!currentTask) continue;

        for (const childId of currentTask.children) {
          descendants.push(childId);
          stack.push(childId);
        }
      }
      return descendants;
    }

    const newCharts: { title: string; slot: number | null; data: { label: string; value: number }[] }[] = [];

    taskMap.forEach(task => {
      if (!task.isSubTask) {
        const descendantIds = getDescendants(task.id);

        const relevantTasks = [task.id, ...descendantIds]
          .map(id => taskMap.get(id))
          .filter(Boolean);

        const statusCounts: Record<string, number> = {
          'Not started': 0,
          'In progress': 0,
          'Await': 0,
          'Done': 0,
        };

        for (const t of relevantTasks) {
          if (t.status in statusCounts) {
            statusCounts[t.status]++;
          }
        }

        newCharts.push({
          title: task.title,
          slot: task.slot,
          data: Object.entries(statusCounts).map(([label, value]) => ({ label, value })),
        });
      }
    });

    newCharts.sort((a, b) => {
      if (a.slot === null && b.slot === null) return 0;
      if (a.slot === null) return 1;
      if (b.slot === null) return -1;
      return a.slot - b.slot;
    });

    // Oblicz zmiany (diff) między cache a nowymi danymi
    let changes: { [title: string]: Record<string, number> } = {};
    if (cache) {
      newCharts.forEach(newChart => {
        const oldChart = cache.find((c: any) => c.title === newChart.title);
        const diff = getChartDiff(oldChart, newChart);
        if (diff) {
          changes[newChart.title] = diff;
        }
      });
    } else {
      // Jeśli brak cache to traktujemy wszystko jako zmiany
      newCharts.forEach(c => {
        changes[c.title] = c.data.reduce((acc, d) => {
          acc[d.label] = d.value;
          return acc;
        }, {} as Record<string, number>);
      });
    }

    cache = newCharts;
    lastFetchTime = Date.now();
    lastModifiedTimestamp = Date.now();

    return NextResponse.json({ charts: newCharts, changes }, {
      headers: {
        'Access-Control-Allow-Origin': FRONTEND_URL,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'X-Last-Modified': lastModifiedTimestamp.toString(),
      },
    });
  } catch (err: any) {
    console.error("❌ Błąd backendu:", err);
    return NextResponse.json({ error: err.message }, {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': FRONTEND_URL,
      }
    });
  }
}

export function OPTIONS() {
  return NextResponse.json(null, {
    headers: {
      'Access-Control-Allow-Origin': FRONTEND_URL,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
