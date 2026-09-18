import { describe, expect, it } from 'vitest';
import { credentialStatus } from './credentialStatus';

describe('credentialStatus', () => {
  it('探测到失效即视为失效，即使本地仍存着 Cookie', () => {
    // 登录失效后 Cookie 不会被清除，只看 hasCookie 会把失效显示成已登录。
    expect(credentialStatus('invalid', true)).toBe('invalid');
    expect(credentialStatus('invalid', false)).toBe('invalid');
  });

  it('探测不到 Cookie 或探测有效时以探测结果为准', () => {
    expect(credentialStatus('valid', true)).toBe('authorized');
    expect(credentialStatus('missing', true)).toBe('unauthorized');
  });

  it('探测失败或尚未探测时回退到本地是否存过，不误报失效', () => {
    expect(credentialStatus('unknown', true)).toBe('authorized');
    expect(credentialStatus('unknown', false)).toBe('unauthorized');
    expect(credentialStatus(null, true)).toBe('authorized');
    expect(credentialStatus(null, false)).toBe('unauthorized');
  });
});
