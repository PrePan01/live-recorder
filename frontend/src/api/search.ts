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
    // 'all' 是前端语义；后端 /search 的 type 仅收 room/recording/alert，省略即全类型。
    type: q.type === 'all' ? undefined : q.type,
    tagId: q.tagId,
    page: q.page,
    pageSize: q.pageSize,
  };
  const { data } = await http.get<SearchResult>('/search', { params });
  return data;
}