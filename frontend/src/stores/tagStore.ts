import { create } from 'zustand';
import * as tagsApi from '../api/tags';
import type { Tag } from '../types/tag';

interface TagState {
  tags: Tag[];
  loading: boolean;
  load: () => Promise<void>;
  create: (input: { name: string; color?: string }) => Promise<Tag>;
  update: (id: string, input: { name?: string; color?: string }) => Promise<Tag>;
  remove: (id: string) => Promise<void>;
}

export const useTagStore = create<TagState>((set) => ({
  tags: [],
  loading: false,
  async load() {
    set({ loading: true });
    try {
      set({ tags: await tagsApi.fetchTags(), loading: false });
    } catch {
      set({ loading: false });
      throw new Error('fetchTags failed');
    }
  },
  async create(input) {
    const tag = await tagsApi.createTag(input);
    set((s) => ({ tags: [...s.tags.filter((t) => t.id !== tag.id), tag] }));
    return tag;
  },
  async update(id, input) {
    const tag = await tagsApi.updateTag(id, input);
    set((s) => ({ tags: s.tags.map((t) => (t.id === id ? tag : t)) }));
    return tag;
  },
  async remove(id) {
    await tagsApi.deleteTag(id);
    set((s) => ({ tags: s.tags.filter((t) => t.id !== id) }));
  },
}));