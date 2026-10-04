import { invoke } from '@tauri-apps/api/core';

const platform = document.documentElement.dataset.platform;
const authorizationCommands = {
  bilibili: 'complete_bilibili_authorization',
  douyin: 'complete_douyin_authorization',
};
if (platform !== 'bilibili' && platform !== 'douyin') {
  throw new Error('授权页面未配置有效平台');
}
const command = authorizationCommands[platform];

const button = document.querySelector<HTMLButtonElement>('#complete')!;
const status = document.querySelector<HTMLSpanElement>('#status')!;

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = '正在读取登录凭证…';
  try {
    await invoke(command);
    status.textContent = '授权成功，正在关闭窗口…';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
});
