/** ECB euro reference rates checked 2026-10-03: CNY7.5259 / USD1.1225.
 * Display estimate only. Authoritative server limits and bills stay in USD.
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml */
export const costDisplayRate = { date: '2026-10-02', usdCny: 7.5259 / 1.1225,
  source: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html' } as const
export function estimatedCny(usd: number): string {
  return Number.isFinite(usd) && usd >= 0 ? (usd * costDisplayRate.usdCny).toFixed(2) : '未知'
}
