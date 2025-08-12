import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";

interface MasterDbRow {
    name: string;
    link: string;
    owner: string;
    active: boolean;
}

interface TaskRow {
    slot: number | null;
    name: string;
    status: "Not started" | "Await" | "In progress" | "Done";
    parent?: string;
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

interface ApiResponse {
    charts: ChartItem[];
}

// ===== Walidacja zmiennych środowiskowych =====
if (!process.env.NOTION_TOKEN) {
    throw new Error("❌ Brak NOTION_TOKEN w zmiennych środowiskowych");
}
if (!process.env.NOTION_DB_ID) {
    throw new Error("❌ Brak NOTION_DB_ID w zmiennych środowiskowych");
}
if (!process.env.NOTION_MASTER_DB_URL) {
    throw new Error("❌ Brak NOTION_MASTER_DB_URL w zmiennych środowiskowych");
}

const notionToken: string = process.env.NOTION_TOKEN;
const notion = new Client({ auth: notionToken });

const masterDbUrl: string = process.env.NOTION_MASTER_DB_URL;

// ===== Pomocnicza funkcja wyciągająca ID bazy z linku =====
function extractDatabaseId(url: string): string {
    const regex = /([0-9a-f]{32})/;
    const match = url.match(regex);
    if (!match) throw new Error(`❌ Nie udało się znaleźć ID bazy w URL: ${url}`);
    return match[1];
}

// ===== Pobieranie danych z Master DB =====
async function fetchMasterDb(): Promise<MasterDbRow[]> {
    const databaseId = extractDatabaseId(masterDbUrl);
    const res = await notion.databases.query({
        database_id: databaseId
    });

    return res.results
        .map((row: any) => {
            const name = row.properties["Nazwa bazy"]?.title?.[0]?.plain_text || "";
            const link = row.properties["Link do bazy"]?.url || "";
            const owner = row.properties["Właściciel"]?.select?.name || "";
            const active = row.properties["Aktywna"]?.checkbox || false;
            return { name, link, owner, active };
        })
        .filter(row => row.active)
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ===== Pobieranie rekordów z bazy =====
async function fetchDatabaseTasks(dbUrl: string, baseName: string): Promise<ChartItem[]> {
    const databaseId = extractDatabaseId(dbUrl);

    const res = await notion.databases.query({
        database_id: databaseId
    });

    const tasks: TaskRow[] = res.results.map((row: any) => {
        const slot = row.properties["Slot"]?.number ?? null;
        const name = row.properties["Name"]?.title?.[0]?.plain_text || "";
        const status = (row.properties["Status"]?.select?.name || "Not started") as TaskRow["status"];
        const parent = row.properties["Parent-item"]?.relation?.[0]?.id || undefined;
        return { slot, name, status, parent };
    });

    // Grupowanie po slocie i statusie
    const groupedBySlot: Record<number | string, Record<string, number>> = {};

    tasks.forEach(task => {
        const slotKey = task.slot ?? "null";
        if (!groupedBySlot[slotKey]) {
            groupedBySlot[slotKey] = { "Not started": 0, "Await": 0, "In progress": 0, "Done": 0 };
        }
        groupedBySlot[slotKey][task.status] = (groupedBySlot[slotKey][task.status] || 0) + 1;
    });

    // Konwersja na ChartItem[]
    const chartItems: ChartItem[] = Object.entries(groupedBySlot).map(([slotKey, statuses]) => ({
        title: `${baseName}::Slot ${slotKey}`,
        slot: slotKey === "null" ? null : Number(slotKey),
        data: Object.entries(statuses).map(([label, value]) => ({ label, value }))
    }));

    return chartItems;
}

// ===== Endpoint API =====
export async function GET() {
    try {
        const masterRows = await fetchMasterDb();

        let allCharts: ChartItem[] = [];

        for (const row of masterRows) {
            const charts = await fetchDatabaseTasks(row.link, row.name);
            allCharts = [...allCharts, ...charts];
        }

        const response: ApiResponse = { charts: allCharts };

        return NextResponse.json(response);
    } catch (err) {
        console.error("❌ Błąd w API:", err);
        return NextResponse.json({ error: "Błąd pobierania danych z Notion" }, { status: 500 });
    }
}
