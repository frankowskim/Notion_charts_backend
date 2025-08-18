import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { broadcastChartsUpdate } from "./ws";

type ChartDataPoint = { label: string; value: number };
type ChartItem = { title: string; slot: number | null; data: ChartDataPoint[] };

type NotionPage = {
  id: string;
  object?: string;
  properties: Record<string, any>;
};

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_MASTER_DB_URL = process.env.NOTION_MASTER_DB_URL;

if (!NOTION_TOKEN)
  throw new Error("Brak NOTION_TOKEN w zmiennych środowiskowych");
if (!NOTION_MASTER_DB_URL)
  throw new Error("Brak NOTION_MASTER_DB_URL w zmiennych środowiskowych");

const notion = new Client({ auth: NOTION_TOKEN });

const FRONTEND_ORIGIN = "https://notioncharts.netlify.app";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ALLOWED_STATUSES = [
  "Not started",
  "Await",
  "In progress",
  "Done",
] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function extractDatabaseIdFromUrl(urlString: string): string {
  if (!urlString || typeof urlString !== "string")
    throw new Error("Invalid URL");
  const clean = urlString.split("?")[0];
  const seg = clean.split("/").filter(Boolean).pop();
  const m = (seg || clean).match(/([0-9a-fA-F]{32}|[0-9a-fA-F\-]{36})/);
  if (!m)
    throw new Error(`Nie udało się wyciągnąć ID bazy z URL: ${urlString}`);
  return m[0].replace(/-/g, "").toLowerCase();
}

function dashifyId(id32: string): string {
  if (!id32 || id32.length !== 32) return id32;
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(
    12,
    16
  )}-${id32.slice(16, 20)}-${id32.slice(20)}`;
}

function isNotionPage(obj: any): obj is NotionPage {
  return (
    !!obj &&
    typeof obj.id === "string" &&
    obj.properties &&
    typeof obj.properties === "object"
  );
}

async function getAllPages(databaseId32: string): Promise<NotionPage[]> {
  if (!databaseId32) return [];
  const database_id = dashifyId(databaseId32);
  let start_cursor: string | undefined;
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

function getPageTitleSafe(p: NotionPage): string {
  const props = p.properties ?? {};
  const nameProp = props["Name"] ?? props["Nazwa"] ?? props["Title"];
  if (!nameProp) return "(no title)";
  if (nameProp.type === "title" && Array.isArray(nameProp.title))
    return nameProp.title.map((t: any) => t.plain_text).join("");
  if (nameProp.type === "rich_text" && Array.isArray(nameProp.rich_text))
    return nameProp.rich_text.map((t: any) => t.plain_text).join("");
  try {
    if (Array.isArray(nameProp))
      return nameProp.map((t: any) => t.plain_text || "").join("");
  } catch {}
  return "(no title)";
}

function readSlotNumberFromPage(p: NotionPage): number | null {
  const props = p.properties ?? {};
  const slotProp = props["Slot"];
  if (!slotProp) return null;
  if (
    slotProp.type === "select" &&
    slotProp.select &&
    typeof slotProp.select.name === "string"
  ) {
    const num = parseInt(slotProp.select.name, 10);
    return Number.isFinite(num) ? num : null;
  }
  if (slotProp.type === "rich_text" && Array.isArray(slotProp.rich_text)) {
    const txt = slotProp.rich_text
      .map((t: any) => t.plain_text)
      .join("")
      .trim();
    const num = parseInt(txt, 10);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function readStatusFromPage(p: NotionPage): AllowedStatus {
  const props = p.properties ?? {};
  const statusProp = props["Status"];
  if (
    statusProp &&
    statusProp.type === "select" &&
    statusProp.select &&
    typeof statusProp.select.name === "string"
  ) {
    const s = statusProp.select.name as string;
    if ((ALLOWED_STATUSES as readonly string[]).includes(s))
      return s as AllowedStatus;
    return "Not started";
  }
  return "Not started";
}

function readParentRelationId(p: NotionPage): string | undefined {
  const props = p.properties ?? {};
  const parentProp =
    props["Parent item"] ?? props["Parent"] ?? props["Parent item (name)"];
  if (!parentProp) return undefined;
  if (
    parentProp.type === "relation" &&
    Array.isArray(parentProp.relation) &&
    parentProp.relation.length > 0
  ) {
    const id = parentProp.relation[0]?.id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

async function readChildDatabasesFromMaster(masterUrl: string) {
  const out: { name: string; url: string; id32: string }[] = [];
  const masterId32 = extractDatabaseIdFromUrl(masterUrl);
  const pages = await getAllPages(masterId32);

  for (const p of pages) {
    const props = p.properties ?? {};
    const activeProp = props["Aktywna"];
    const linkProp = props["Link do bazy"];
    const nameProp = props["Nazwa bazy"];

    const isActive = !!(
      activeProp &&
      activeProp.type === "checkbox" &&
      activeProp.checkbox === true
    );
    if (!isActive) continue;

    let name = "";
    if (nameProp) {
      if (nameProp.type === "title" && Array.isArray(nameProp.title))
        name = nameProp.title.map((t: any) => t.plain_text).join("");
      else if (
        nameProp.type === "rich_text" &&
        Array.isArray(nameProp.rich_text)
      )
        name = nameProp.rich_text.map((t: any) => t.plain_text).join("");
      else if (typeof nameProp === "string") name = nameProp;
    }

    let url: string | null = null;
    if (linkProp) {
      if (
        linkProp.type === "url" &&
        typeof linkProp.url === "string" &&
        linkProp.url.length > 0
      )
        url = linkProp.url;
      else if (
        linkProp.type === "rich_text" &&
        Array.isArray(linkProp.rich_text)
      ) {
        const s = linkProp.rich_text.map((t: any) => t.plain_text).join("");
        if (s) url = s;
      } else if (linkProp.type === "title" && Array.isArray(linkProp.title)) {
        const s = linkProp.title.map((t: any) => t.plain_text).join("");
        if (s) url = s;
      }
    }
    if (!url) {
      console.warn(
        "Master DB row active ale brak Link do bazy — pomijam. Page id:",
        p.id
      );
      continue;
    }

    try {
      const id32 = extractDatabaseIdFromUrl(url);
      out.push({ name: name || url, url, id32 });
    } catch (err) {
      console.warn(
        "Nie można wyciągnąć ID z Link do bazy, pomijam:",
        url,
        (err as Error).message
      );
    }
  }

  return out;
}

async function buildChartsForDatabase(
  id32: string,
  databaseName: string
): Promise<ChartItem[]> {
  const pages = await getAllPages(id32);
  if (!pages.length) return [];

  const pagesById = new Map<string, NotionPage>();
  pages.forEach((p) => pagesById.set(p.id, p));

  const parentPages = pages.filter((p) => readSlotNumberFromPage(p) !== null);
  const parentCounts = new Map<string, Record<AllowedStatus, number>>();

  for (const parent of parentPages) {
    const zero = Object.fromEntries(
      ALLOWED_STATUSES.map((s) => [s, 0])
    ) as Record<AllowedStatus, number>;
    parentCounts.set(parent.id, zero);
  }

  for (const page of pages) {
    let targetParentId: string | undefined;
    const ownSlot = readSlotNumberFromPage(page);

    if (ownSlot !== null) {
      targetParentId = page.id;
    } else {
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

    if (!targetParentId) continue;
    const status = readStatusFromPage(page);
    const counts = parentCounts.get(targetParentId);
    if (counts) counts[status] = (counts[status] || 0) + 1;
  }

  const items: ChartItem[] = parentPages.map((parent) => {
    const slot = readSlotNumberFromPage(parent);
    const title = `${databaseName}::${getPageTitleSafe(parent)}`;
    const counts =
      parentCounts.get(parent.id) ??
      (Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0])) as Record<
        AllowedStatus,
        number
      >);
    const data: ChartDataPoint[] = ALLOWED_STATUSES.map((s) => ({
      label: s,
      value: counts[s] ?? 0,
    }));
    return { title, slot, data };
  });

  items.sort(
    (a, b) =>
      (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER)
  );
  return items;
}

export async function GET() {
  try {
    const childDbs = await readChildDatabasesFromMaster(NOTION_MASTER_DB_URL!);
    if (!childDbs.length) {
      return new NextResponse(JSON.stringify({ charts: [] }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const allCharts: ChartItem[] = [];
    for (const child of childDbs) {
      try {
        const charts = await buildChartsForDatabase(child.id32, child.name);
        allCharts.push(...charts);
      } catch (err) {
        console.error("Błąd dla bazy:", child.name, err);
      }
    }

    // 🔥 poprawka — przekazujemy argument
    broadcastChartsUpdate(allCharts);

    return new NextResponse(JSON.stringify({ charts: allCharts }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("API error:", err);
    return new NextResponse(
      JSON.stringify({ error: (err as Error).message || "unknown" }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
