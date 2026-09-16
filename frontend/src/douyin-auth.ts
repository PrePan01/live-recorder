import { invoke } from '@tauri-apps/api/core';

const button = document.querySelector<HTMLButtonElement>('#complete')!;
const status = document.querySelector<HTMLSpanElement>('#status')!;

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = '正在读取登录凭证…';
  try {
    await invoke('complete_douyin_authorization');
    status.textContent = '授权成功，正在关闭窗口…';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
});
