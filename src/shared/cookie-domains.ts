export function normalizeCookieDomains(domains: string[]): string[] {
  return [...new Set(domains.map((value) => {
    const domain = value.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    if (domain.length > 253 || !domain.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`Invalid cookie domain: ${value}. Enter a hostname without a URL, port or wildcard.`);
    }
    return domain;
  }))];
}

export function cookieDomainAllowed(cookieDomain: string, domains: string[]): boolean {
  const domain = cookieDomain.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  return domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}
