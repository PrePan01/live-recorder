import { http } from "./client";
export interface QmsgConfig {
  enabled: boolean;
  keySet: boolean;
}
export async function fetchQmsg(): Promise<QmsgConfig> {
  return (await http.get<{ qmsg: QmsgConfig }>("/settings/qmsg")).data.qmsg;
}
export async function updateQmsg(input: {
  enabled?: boolean;
  key?: string;
  clearKey?: boolean;
}): Promise<QmsgConfig> {
  return (await http.put<{ qmsg: QmsgConfig }>("/settings/qmsg", input)).data
    .qmsg;
}
export async function testQmsg(): Promise<void> {
  await http.post("/settings/qmsg/test", undefined, { timeout: 20_000 });
}
