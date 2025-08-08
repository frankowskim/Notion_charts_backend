import { NextResponse } from 'next/server';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const MASTER_DB_ID = process.env.NOTION_MASTER_DB_ID!;

function getCheckbox(prop: any): boolean {
  return prop?.type === 'checkbox' ? prop.checkbox : false;
}

function getSelectName(prop: any): string | null {
  return prop?.type === 'select' && prop.select ? prop.select.name : null;
}

function getRichText(prop: any): string {
  if (prop?.type === 'rich_text') {
    return prop.rich_text.map((rt: any) => rt.plain_text).join('');
  }
  return '';
}

function getTitle(prop: any): string {
  if (prop?.type === 'title') {
    return prop.title.map((t: any) => t.plain_text).join('');
  }
  return '';
}

function getUrl(prop: any): string | null {
  return prop?.type === 'url' && prop.url ? prop.url : null;
}

export async function GET() {
  try {
    const response = await notion.databases.query({
      database_id: MASTER_DB_ID,
      filter: {
        property: 'Aktywna',
        checkbox: {
          equals: true,
        },
      },
      page_size: 100,
    });

    const bases = response.results.map((page: any) => {
      const props = page.properties;

      return {
        id: page.id,
        name: getTitle(props['Nazwa bazy']) || getRichText(props['Nazwa bazy']),
        url: getUrl(props['Link do bazy']),
        owner: getSelectName(props['Właściciel']),
        description: getRichText(props['Opis']),
        active: getCheckbox(props['Aktywna']),
      };
    });

    return NextResponse.json({ bases });
  } catch (error) {
    console.error('❌ Błąd podczas pobierania master bazy:', error);
    return NextResponse.json({ error: 'Błąd serwera' }, { status: 500 });
  }
}
