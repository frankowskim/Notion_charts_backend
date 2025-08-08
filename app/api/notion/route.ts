import type { NextApiRequest, NextApiResponse } from 'next';
import { Client } from '@notionhq/client';
import {
  PageObjectResponse,
  PartialPageObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';

// Wyciąga 32-znakowy ID z URL
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

// Zamienia 32-znakowy ID na UUID (z myślnikami)
function expandNotionId(id: string): string {
  return id.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    '$1-$2-$3-$4-$5'
  );
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });

type Data = {
  data?: Array<{
    id: string;
    nazwa: string | null;
    link: string | null;
    wlasciciel: string | null;
    aktywna: boolean;
    opis: string | null;
  }>;
  error?: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const dbUrl = process.env.NOTION_MASTER_DB_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: 'Brak NOTION_MASTER_DB_URL w środowisku' });
  }

  const compressedId = extractNotionIdFromUrl(dbUrl);
  if (!compressedId) {
    return res.status(400).json({ error: 'Niepoprawny URL bazy Notion' });
  }

  const notionDbId = expandNotionId(compressedId);

  try {
    const response = await notion.databases.query({ database_id: notionDbId });

    // Filtrowanie wyników - mamy union typów, sprawdzamy czy properties istnieje i czy to PageObjectResponse
    const pages = response.results.filter(
      (page): page is PageObjectResponse => 'properties' in page
    );

    const results = pages.map((page) => {
      const props = page.properties;

      // Tutaj zwracamy wartości, uwzględniając możliwą nieobecność danych
      return {
        id: page.id,
        nazwa: props['Nazwa bazy']?.type === 'title' && props['Nazwa bazy'].title.length > 0
          ? props['Nazwa bazy'].title[0].plain_text
          : null,
        link: props['Link do bazy']?.type === 'url'
          ? props['Link do bazy'].url
          : null,
        wlasciciel: props['Właściciel']?.type === 'select' && props['Właściciel'].select
          ? props['Właściciel'].select.name
          : null,
        aktywna: props['Aktywna']?.type === 'checkbox'
          ? props['Aktywna'].checkbox
          : false,
        opis: props['Opis']?.type === 'rich_text' && props['Opis'].rich_text.length > 0
          ? props['Opis'].rich_text[0].plain_text
          : null,
      };
    });

    return res.status(200).json({ data: results });
  } catch (error) {
    console.error('❌ Błąd podczas pobierania master bazy:', error);
    const message = error instanceof Error ? error.message : 'Nieznany błąd';
    return res.status(500).json({ error: message });
  }
}
