import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Room } from "../../../types/room";

export function useRoomList(rooms: Room[]) {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState("");
  const [platform, setPlatform] = useState<string>();
  const [state, setState] = useState<string>();
  const [favOnly, setFavOnly] = useState<boolean>(false);
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rooms.filter((r) => {
      if (
        kw &&
        !r.displayName.toLowerCase().includes(kw) &&
        !r.url.toLowerCase().includes(kw)
      )
        return false;
      if (platform && r.platform !== platform) return false;
      if (state && r.monitorState !== state) return false;
      if (favOnly && !r.favorited) return false;
      return !(
        filterTagIds.length > 0 &&
        !filterTagIds.some((tagId) => r.tags.some((tag) => tag.id === tagId))
      );
    });
  }, [rooms, keyword, platform, state, favOnly, filterTagIds]);

  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize],
  );

  useEffect(() => {
    const params = new URLSearchParams(search);
    const focusId = params.get("focus");
    if (!focusId || !rooms.some((room) => room.id === focusId)) return;
    const idx = filtered.findIndex((room) => room.id === focusId);
    if (idx === -1) {
      setKeyword("");
      setPlatform(undefined);
      setState(undefined);
      setFavOnly(false);
      setFilterTagIds([]);
      return;
    }
    const targetPage = Math.floor(idx / pageSize) + 1;
    if (currentPage !== targetPage) {
      setPage(targetPage);
      return;
    }
    // Wait for the target page to commit before locating its card.
    const frame = requestAnimationFrame(() => {
      const el = Array.from(
        document.querySelectorAll<HTMLElement>(".lr-room-management-card[data-room-id]"),
      ).find((card) => card.dataset.roomId === focusId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.animate(
        [{ backgroundColor: "var(--lr-hover-bg)" }, { backgroundColor: "transparent" }],
        { duration: 2000 },
      );
      params.delete("focus");
      navigate({ pathname: "/rooms", search: params.toString() }, { replace: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [search, rooms, filtered, pageSize, currentPage, navigate]);

  const resetPage = () => setPage(1);

  return {
    keyword,
    setKeyword,
    platform,
    setPlatform,
    state,
    setState,
    favOnly,
    setFavOnly,
    filterTagIds,
    setFilterTagIds,
    pageSize,
    setPageSize,
    setPage,
    currentPage,
    filtered,
    paginated,
    resetPage,
  };
}
