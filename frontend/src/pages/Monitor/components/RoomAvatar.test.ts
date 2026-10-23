import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { expect, it } from "vitest";
import RoomAvatar from "./RoomAvatar";
import { baseUrl } from '../../../api/client';

it('YouTube avatars use the local image route while other platforms keep their original URLs', () => {
  const avatarUrl = 'https://yt3.ggpht.com/avatar';
  const markup = renderToStaticMarkup(createElement(RoomAvatar, { platform: 'youtube', roomId: 'room1', avatarUrl }));
  expect(markup).toContain(`${baseUrl()}/rooms/room1/avatar?v=${encodeURIComponent(avatarUrl)}`);
  expect(renderToStaticMarkup(createElement(RoomAvatar, { platform: 'xiaohongshu', roomId: 'room1', avatarUrl }))).toContain(`src="${avatarUrl}"`);
});

const render = (platform: "bilibili" | "douyin" | "xiaohongshu", name?: string) =>
  renderToStaticMarkup(createElement(RoomAvatar, { platform, name }));

it("无头像兜底字按平台取字，小红书不再落抖音字", () => {
  expect(render("bilibili")).toContain(">B</span>");
  expect(render("douyin")).toContain(">抖</span>");
  expect(render("xiaohongshu")).toContain(">红</span>");
});

it("兜底态带平台底色变体类名", () => {
  expect(render("xiaohongshu")).toContain("lr-room-avatar--xiaohongshu");
  expect(render("xiaohongshu")).toContain("lr-room-avatar--fallback");
});

it("有名字时兜底字用名字首字，平台字只做无名兜底", () => {
  expect(render("xiaohongshu", "小明")).toContain(">小</span>");
});
