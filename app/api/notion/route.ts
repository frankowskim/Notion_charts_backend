// app/api/notion/route.ts
import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";

/**
 * Backend API który:
 * - bierze NOTION_TOKEN i NOTION_MASTER_DB_URL z env
 * - z Master DB bierze aktywne linki do baz podrzędnych (kolumny: 'Nazwa bazy', 'Link do bazy', 'Aktywna')
 * - dla każdej aktywnej bazy pobiera wszystkie strony, znajduje rodziców z polem 'Slot' i agreguje zadania (wraz z subtaskami) wg Status
 *
 * Zwraca: { charts: ChartItem[] }
 */

/* ----------------------------- Typy lokalne ----------------------------- */

type ChartDataPoint = { label: string; value: number };
type ChartItem = { title: string; slot: number | null; data: ChartDataPoint[] };

// proste odwzorowanie strony Notion — tylko potrzebne pola
type NotionPage = {
  id: string;
  object?: string;
  properties: Record<string, any>;
};

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_MASTER_DB_URL = process.env.NOTION_MASTER_DB_URL;

if (!NOTION_TOKEN) throw new Error("Brak NOTION_TOKEN w zmiennych środowiskowych");
if (!NOTION_MASTER_DB_URL) throw new Error("Brak NOTION_MASTER_DB_URL w zmiennych środowiskowych");

const notion = new Client({ auth: NOTION_TOKEN });

// frontend origin dla CORS — zmień jeśli potrzeba
const FRONTEND_ORIGIN = "https://notioncharts.netlify.app";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// statusy (kolejność na wykresie)
const ALLOWED_STATUSES = ["Not started", "Await", "In progress", "Done"] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

/* --------------------------- Helper functions --------------------------- */

/** Wyciąga 32-znakowy id bazy z pełnego URL Notion (bez myślników) */
function extractDatabaseIdFromUrl(urlString: string): string {
  if (!urlString || typeof urlString !== "string") throw new Error("Invalid URL");
  // usuń query string
  const clean = urlString.split("?")[0];
  const seg = clean.split("/").filter(Boolean).pop();
  // spróbuj dopasować 32-hex lub 36 z dashami
  const m = (seg || clean).match(/([0-9a-fA-F]{32}|[0-9a-fA-F\-]{36})/);
  if (!m) throw new Error(`Nie udało się wyciągnąć ID bazy z URL: ${urlString}`);
  return m[0].replace(/-/g, "").toLowerCase();
}

/** Dodaje myślniki do 32-znakowego ID (8-4-4-4-12) */
function dashifyId(id32: string): string {
  if (!id32 || id32.length !== 32) return id32;
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`;
}

/** Type-guard dla Page z Notion (ma properties i id) */
function isNotionPage(obj: any): obj is NotionPage {
  return !!obj && typeof obj.id === "string" && obj.properties && typeof obj.properties === "object";
}

/** Pobrać wszystkie strony z bazy (paginacja) — oczekuje 32-znakowego id bez myślników */
async function getAllPages(databaseId32: string): Promise<NotionPage[]> {
  if (!databaseId32) return [];
  const database_id = dashifyId(databaseId32);
  let start_cursor: string | undefined = undefined;
  const out: NotionPage[] = [];

  do {
    const res: any = await notion.databases.query({
      database_id,
      start_cursor,
      page_size: 100,
    } as any);

    const results: any[] = Array.isArray(res.results) ? res.results : [];
    for (const r of results) {
      if (isNotionPage(r)) out.push(r);
    }

    if (res.has_more) start_cursor = res.next_cursor ?? undefined;
    else start_cursor = undefined;
  } while (start_cursor);

  return out;
}

/** Odczytuje tytuł/Name strony (bezpiecznie) */
function getPageTitleSafe(p: NotionPage): string {
  const props = p.properties ?? {};
  const nameProp = props["Name"] ?? props["Nazwa"] ?? props["Title"];
  if (!nameProp) return "(no title)";
  if (nameProp.type === "title" && Array.isArray(nameProp.title)) return nameProp.title.map((t: any) => t.plain_text).join("");
  if (nameProp.type === "rich_text" && Array.isArray(nameProp.rich_text)) return nameProp.rich_text.map((t: any) => t.plain_text).join("");
  // fallback: próbuj plain_text jeśli strukturę masz inną
  try {
    if (Array.isArray(nameProp)) return nameProp.map((t: any) => t.plain_text || "").join("");
  } catch { /** noop */ }
  return "(no title)";
}

/** Czytanie slotu — jeśli select.name to liczba, zwraca number lub null */
function readSlotNumberFromPage(p: NotionPage): number | null {
  const props = p.properties ?? {};
  const slotProp = props["Slot"];
  if (!slotProp) return null;
  if (slotProp.type === "select" && slotProp.select && typeof slotProp.select.name === "string") {
    const num = parseInt(slotProp.select.name, 10);
    return Number.isFinite(num) ? num : null;
  }
  if (slotProp.type === "rich_text" && Array.isArray(slotProp.rich_text)) {
    const txt = slotProp.rich_text.map((t: any) => t.plain_text).join("").trim();
    const num = parseInt(txt, 10);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/** Czytanie statusu — zwraca AllowedStatus (domyślnie 'Not started') */
function readStatusFromPage(p: NotionPage): AllowedStatus {
  const props = p.properties ?? {};
  const statusProp = props["Status"];
  if (statusProp && statusProp.type === "select" && statusProp.select && typeof statusProp.select.name === "string") {
    const s = statusProp.select.name as string;
    if ((ALLOWED_STATUSES as readonly string[]).includes(s)) return s as AllowedStatus;
    return "Not started";
  }
  return "Not started";
}

/** Czytanie parent relation id (jeśli jest) — zwraca undefined jeśli brak */
function readParentRelationId(p: NotionPage): string | undefined {
  const props = p.properties ?? {};
  const parentProp = props["Parent item"] ?? props["Parent"] ?? props["Parent item (name)"];
  if (!parentProp) return undefined;
  if (parentProp.type === "relation" && Array.isArray(parentProp.relation) && parentProp.relation.length > 0) {
    const id = parentProp.relation[0]?.id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/* ---------------------- Odczyt z Master DB (listy baz) --------------------- */

/**
 * Czyta Master DB (podany jako URL w NOTION_MASTER_DB_URL) i zwraca
 * aktywne wpisy: { name, url, id32 }
 */
async function readChildDatabasesFromMaster(masterUrl: string): Promise<{ name: string; url: string; id32: string }[]> {
  const out: { name: string; url: string; id32: string }[] = [];

  const masterId32 = extractDatabaseIdFromUrl(masterUrl);
  const pages = await getAllPages(masterId32);

  for (const p of pages) {
    const props = p.properties ?? {};
    const activeProp = props["Aktywna"];
    const linkProp = props["Link do bazy"];
    const nameProp = props["Nazwa bazy"];

    const isActive = !!(activeProp && activeProp.type === "checkbox" && activeProp.checkbox === true);
    if (!isActive) continue;

    // name
    let name = "";
    if (nameProp) {
      if (nameProp.type === "title" && Array.isArray(nameProp.title)) name = nameProp.title.map((t: any) => t.plain_text).join("");
      else if (nameProp.type === "rich_text" && Array.isArray(nameProp.rich_text)) name = nameProp.rich_text.map((t: any) => t.plain_text).join("");
      else if (typeof nameProp === "string") name = nameProp;
    }

    // url (bezpiecznie)
    let url: string | null = null;
    if (linkProp) {
      if (linkProp.type === "url" && typeof linkProp.url === "string" && linkProp.url.length > 0) url = linkProp.url;
      else if (linkProp.type === "rich_text" && Array.isArray(linkProp.rich_text)) {
        const s = linkProp.rich_text.map((t: any) => t.plain_text).join("");
        if (s) url = s;
      } else if (linkProp.type === "title" && Array.isArray(linkProp.title)) {
        const s = linkProp.title.map((t: any) => t.plain_text).join("");
        if (s) url = s;
      }
    }
    if (!url) {
      // brak URL — pomijamy (logujemy)
      console.warn("Master DB row active ale brak Link do bazy — pomijam. Page id:", p.id);
      continue;
    }

    // spróbuj wyciągnąć ID z url (bezpiecznie)
    try {
      const id32 = extractDatabaseIdFromUrl(url);
      out.push({ name: name || url, url, id32 });
    } catch (err) {
      console.warn("Nie można wyciągnąć ID z Link do bazy, pomijam:", url, (err as Error).message);
      continue;
    }
  }

  return out;
}

/* -------------------------- Budowanie wykresów -------------------------- */

/**
 * Dla danej bazy (id32) buduje ChartItem[]:
 * - wyszukuje wszystkie rodziców (pages z Slot !== null)
 * - dla każdej strony (rodzic + subtasks) przypisuje ją do najbliższego przodka z Slot
 * - agreguje liczbę zadań wg statusów ALLOWED_STATUSES
 */
async function buildChartsForDatabase(id32: string, databaseName: string): Promise<ChartItem[]> {
  const pages = await getAllPages(id32);
  if (!pages.length) return [];

  const pagesById = new Map<string, NotionPage>();
  pages.forEach((p) => pagesById.set(p.id, p));

  // rodzice = strony które mają slot
  const parentPages = pages.filter((p) => readSlotNumberFromPage(p) !== null);

  // przygotuj mapę counts
  const parentCounts = new Map<string, Record<AllowedStatus, number>>();
  for (const parent of parentPages) {
    const zero = Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0])) as Record<AllowedStatus, number>;
    parentCounts.set(parent.id, zero);
  }

  // dla każdej strony - znajdź docelowego rodzica (najbliższy ancestor z Slot)
  for (const page of pages) {
    let targetParentId: string | undefined;

    const ownSlot = readSlotNumberFromPage(page);
    if (ownSlot !== null) {
      targetParentId = page.id;
    } else {
      // wspinamy się po relacji Parent item
      let currParentId = readParentRelationId(page);
      let depth = 0;
      while (currParentId && depth < 30) {
        if (parentCounts.has(currParentId)) {
          targetParentId = currParentId;
          break;
        }
        const parentPage = pagesById.get(currParentId);
        if (!parentPage) break;
        currParentId = readParentRelationId(parentPage);
        depth++;
      }
    }

    if (!targetParentId) {
      // nie ma przypisanego rodzica z slotem — pomiń tę stronę
      continue;
    }

    // zlicz status
    const status = readStatusFromPage(page);
    const counts = parentCounts.get(targetParentId);
    if (counts) counts[status] = (counts[status] || 0) + 1;
  }

  // zbuduj ChartItemy
  const items: ChartItem[] = parentPages.map((parent) => {
    const slot = readSlotNumberFromPage(parent);
    const title = `${databaseName}::${getPageTitleSafe(parent)}`;
    const counts = parentCounts.get(parent.id) ?? (Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0])) as Record<AllowedStatus, number>);
    const data: ChartDataPoint[] = ALLOWED_STATUSES.map((s) => ({ label: s, value: counts[s] ?? 0 }));
    return { title, slot, data };
  });

  // sort by slot (null -> end)
  items.sort((a, b) => {
    const A = a.slot ?? Number.MAX_SAFE_INTEGER;
    const B = b.slot ?? Number.MAX_SAFE_INTEGER;
    return A - B;
  });

  return items;
}

/* ------------------------------ Route Handlers ------------------------------ */

export async function GET() {
  try {
    // 1) z master DB odczytujemy listę aktywnych baz (url + id32)
    const childDbs = await readChildDatabasesFromMaster(NOTION_MASTER_DB_URL!);
    if (!childDbs.length) {
      return new NextResponse(JSON.stringify({ charts: [] }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 2) dla każdej bazy budujemy wykresy
    const allCharts: ChartItem[] = [];
    for (const child of childDbs) {
      try {
        const charts = await buildChartsForDatabase(child.id32, child.name);
        allCharts.push(...charts);
      } catch (err) {
        console.error("Błąd dla bazy:", child.name, err);
      }
    }

    return new NextResponse(JSON.stringify({ charts: allCharts }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("API error:", err);
    return new NextResponse(JSON.stringify({ error: (err as Error).message || "unknown" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
