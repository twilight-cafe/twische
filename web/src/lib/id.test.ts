import { describe, it, expect, vi, afterEach } from 'vitest';
import { uuid, shortId } from './id';

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uuid', () => {
  it('优先使用 crypto.randomUUID', () => {
    expect(V4_RE.test(uuid())).toBe(true);
  });

  it('randomUUID 抛错时退回 getRandomValues 手工拼装', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (buf: Uint8Array) => {
        for (let i = 0; i < buf.length; i++) buf[i] = i;
        return buf;
      },
      randomUUID: () => {
        throw new Error('non-secure context');
      },
    });
    const id = uuid();
    expect(V4_RE.test(id)).toBe(true);
    expect(id).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('完全没有 crypto 时退回随机字符串兜底', () => {
    vi.stubGlobal('crypto', undefined);
    const id = uuid();
    expect(id).toMatch(/^id-[0-9a-z]+-[0-9a-z]+$/);
  });
});

describe('shortId', () => {
  it('默认前缀 t', () => {
    expect(shortId()).toMatch(/^t_[0-9a-z]+[0-9a-z]{6}$/);
  });

  it('自定义前缀', () => {
    expect(shortId('c')).toMatch(/^c_/);
  });
});
