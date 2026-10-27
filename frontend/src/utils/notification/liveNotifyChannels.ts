import type { Settings } from "../../types/settings";

/**
 * 开播提醒的真启用渠道：设置页事件开关开启，且渠道本身已启用可用
 * （桌面=系统通知可用，邮件=已启用且 SMTP 配置齐，QQ=已启用且 Key 已存）。
 */
export function liveNotifyChannels(
  settings: Settings | null,
  desktopAvailable: boolean,
): string[] {
  const events = settings?.notifications;
  const names: string[] = [];
  if (events?.desktop?.liveStarted && desktopAvailable) names.push("桌面");
  const mail = settings?.mail;
  if (
    events?.email?.liveStarted &&
    mail?.enabled &&
    mail.host &&
    mail.from &&
    (mail.recipients?.length ?? 0) > 0
  )
    names.push("邮件");
  const qmsg = settings?.qmsg;
  if (events?.qq?.liveStarted && qmsg?.enabled && qmsg.keySet) names.push("QQ");
  return names;
}

/** 「将通过桌面与QQ通知」：两项用「与」连接，三项用顿号加「与」。 */
export function liveNotifySentence(names: string[]): string {
  const joined =
    names.length > 1
      ? `${names.slice(0, -1).join("、")}与${names[names.length - 1]}`
      : names[0];
  return `将通过${joined}通知`;
}
