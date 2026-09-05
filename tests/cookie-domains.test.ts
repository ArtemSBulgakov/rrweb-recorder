import { describe, expect, it } from 'vitest';
import { cookieDomainAllowed, normalizeCookieDomains } from '../src/shared/cookie-domains';

describe('cookie domain selection', () => {
  it('normalizes pasted hostnames and removes duplicates', () => {
    expect(normalizeCookieDomains([' .Example.COM ', 'example.com.', 'login.example.org', '127.0.0.1']))
      .toEqual(['example.com', 'login.example.org', '127.0.0.1']);
  });

  it.each(['https://example.com', 'example.com/path', '*.example.com', 'example.com:443',
    'example..com', '-example.com', 'example-.com', '', 'a'.repeat(64) + '.com'])('rejects invalid domain %s', (domain) => {
    expect(() => normalizeCookieDomains([domain])).toThrow('Invalid cookie domain');
  });

  it.each(['example.com', '.example.com', 'login.example.com', '.LOGIN.EXAMPLE.COM'])('includes %s without altering cookie values', (domain) => {
    expect(cookieDomainAllowed(domain, ['example.com'])).toBe(true);
  });

  it.each(['notexample.com', 'example.com.evil.test', 'other.test'])('excludes unrelated domain %s', (domain) => {
    expect(cookieDomainAllowed(domain, ['example.com'])).toBe(false);
  });

  it('does not implicitly include parent-domain cookies', () => {
    expect(cookieDomainAllowed('.example.com', ['login.example.com'])).toBe(false);
  });

  it('captures no cookies with an empty allowlist', () => {
    expect(cookieDomainAllowed('.example.com', [])).toBe(false);
  });
});
