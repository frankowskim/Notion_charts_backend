import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import type {
  PageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

function extractNotionIdFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const pathSegments = parsedUrl.pathname.split('/');
    for (const segment of pathSegments) {
      if (segment.length === 32 && /^[0-9a-f]{32}$/.test(segment)) {
        return segment;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function expandNotionId(id: string): string {
  return id.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    '$1-$2-$3-$4-$5'
  );
}

export async function GET() {
  const dbUrl = process.env.NOTION_MASTER_DB_URL;
  
  if (!dbUrl) {
    return NextResponse.json({ error: 'Brak NOTION_MASTER_DB_URL w środowisku' }, { status: 500 });
  }

  const compressedId = extractNotionIdFromUrl(dbUrl);
  if (!compressedId) {
    return NextResponse.json({ error: 'Niepoprawny URL bazy Notion' }, { status: 400 });
  }

  const notionDbId = expandNotionId(compressedId);

  try {
    const response = await notion.databases.query({ database_id: notionDbId });

    const pages = response.results.filter(
      (page): page is PageObjectResponse => 'properties' in page
    );
console.log('Pobrane dane z Notion:', JSON.stringify(response, null, 2));
    const results = pages.map((page) => {
      const props = page.properties;

      return {
        id: page.id,
        nazwa:
          props['Nazwa bazy']?.type === 'title' && props['Nazwa bazy'].title.length > 0
            ? props['Nazwa bazy'].title[0].plain_text
            : null,
        link: props['Link do bazy']?.type === 'url' ? props['Link do bazy'].url : null,
        wlasciciel:
          props['Właściciel']?.type === 'select' && props['Właściciel'].select
            ? props['Właściciel'].select.name
            : null,
        aktywna: props['Aktywna']?.type === 'checkbox' ? props['Aktywna'].checkbox : false,
        opis:
          props['Opis']?.type === 'rich_text' && props['Opis'].rich_text.length > 0
            ? props['Opis'].rich_text[0].plain_text
            : null,
      };
    });

    return NextResponse.json({ data: results });
  } catch (error) {
    console.error('❌ Błąd podczas pobierania master bazy:', error);
    const message = error instanceof Error ? error.message : 'Nieznany błąd';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
