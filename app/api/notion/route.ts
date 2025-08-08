import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";

// Typ jednej bazy z Master DB
type ActiveBase = {
  name: string;
  link: string;
};

// Funkcja wyciągająca ID z linku do bazy Notion
function extractDatabaseIdFromUrl(url: string): string {
  const match = url.match(/([a-f0-9]{32})/);
  if (!match) {
    throw new Error("Nie udało się znaleźć ID bazy w podanym URL");
  }
  const rawId = match[1];
  // Wstaw myślniki w formacie UUID
  return `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}`;
}

export async function GET() {
  try {
    const notion = new Client({
      auth: process.env.NOTION_TOKEN,
    });

    if (!process.env.NOTION_MASTER_DB_URL) {
      return NextResponse.json(
        { error: "Brak zmiennej środowiskowej NOTION_MASTER_DB_URL" },
        { status: 500 }
      );
    }

    const masterDbId = extractDatabaseIdFromUrl(process.env.NOTION_MASTER_DB_URL);

    // Pobieramy dane z master DB
    const masterData = await notion.databases.query({
      database_id: masterDbId,
    });

    // Wyciągamy aktywne bazy
    const activeBases: ActiveBase[] = masterData.results
      .map((page: any) => {
        if (!("properties" in page)) return null;
        const props = page.properties;

        const link = props["Link do bazy"]?.type === "url" ? props["Link do bazy"].url : null;
        const active =
          props["Aktywna"]?.type === "checkbox" ? props["Aktywna"].checkbox : false;
        const name =
          props["Nazwa bazy"]?.type === "title"
            ? props["Nazwa bazy"].title[0]?.plain_text || ""
            : "";

        if (!link || !active || !name) return null;

        return { name, link };
      })
      .filter((base): base is ActiveBase => base !== null);

    // Tu możesz chcieć pobrać dane z każdej aktywnej bazy, ale na razie zwracamy tylko listę
    return NextResponse.json({ bases: activeBases });
  } catch (error: unknown) {
    console.error("❌ Błąd backendu:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Nieznany błąd" },
      { status: 500 }
    );
  }
}
