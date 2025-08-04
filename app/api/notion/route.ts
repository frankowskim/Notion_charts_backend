import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export async function GET() {
  try {
    const databaseId = process.env.NOTION_DB_ID!;
    const response = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
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

      console.log(`Task: ${title} | ParentId: ${parentId} | IsSubTask: ${isSubTask}`);

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

    // Zbuduj drzewo
    taskMap.forEach(task => {
      if (task.parentId) {
        if (taskMap.has(task.parentId)) {
          taskMap.get(task.parentId).children.push(task.id);
        } else {
          console.warn(`Rodzic z ID ${task.parentId} dla zadania ${task.title} nie istnieje w mapie!`);
        }
      }
    });

    // Funkcja do zbierania potomków
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

    const charts: { title: string; slot: number | null; data: { label: string; value: number }[] }[] = [];

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
          console.log(`[${task.title}] ➜ zadanie "${t.title}" ma status: "${t.status}"`);

          if (t.status in statusCounts) {
            statusCounts[t.status]++;
          } else {
            console.warn(`⚠️ Nieznany status "${t.status}" dla zadania "${t.title}"`);
          }
        }

        charts.push({
          title: task.title,
          slot: task.slot,
          data: Object.entries(statusCounts).map(([label, value]) => ({ label, value })),
        });
      }
    });

    // Sortowanie po slocie (null na końcu)
    charts.sort((a, b) => {
      if (a.slot === null && b.slot === null) return 0;
      if (a.slot === null) return 1;
      if (b.slot === null) return -1;
      return a.slot - b.slot;
    });

    return NextResponse.json(charts, {
      headers: {
        'Access-Control-Allow-Origin': 'https://notioncharts.netlify.app',

        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  } catch (err: any) {
    console.error("❌ Błąd backendu:", err);
    return NextResponse.json({ error: err.message }, {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': 'http://localhost:5173',
      }
    });
  }
}

// Obsługa preflight CORS
export function OPTIONS() {
  return NextResponse.json(null, {
    headers: {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
