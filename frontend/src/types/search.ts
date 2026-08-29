export type SearchItemType = 'room' | 'recording' | 'alert';

export interface SearchItem {
  type: SearchItemType;
  id: string;
  title: string;
  subtitle: string | null;
  occurredAt: string | null;
  extra: Record<string, unknown>;
}

export interface SearchResult {
  query: string;
  type: 'all' | SearchItemType;
  tagId: string | null;
  from: string | null;
  to: string | null;
  page: number;
  pageSize: number;
  total: number;
  timeout: boolean;
  items: SearchItem[];
}