import { http } from './client';
import type { SearchResult, SearchItemType } from '../types/search';

export interface SearchQuery {
  q: string;
  type?: 'all' | SearchItemType;
  tagId?: string;
  page?: number;
  pageSize?: number;
}

export async function searchGlobal(q: SearchQuery): Promise<SearchResult> {
  const params: Record<string, string | number | undefined> = {
    q: q.q,
    type: q.type,
    tagId: q.tagId,
    page: q.page,
    pageSize: q.pageSize,
  };
  const { data } = await http.get<SearchResult>('/search', { params });
  return data;
}