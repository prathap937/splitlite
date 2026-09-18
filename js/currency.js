export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD', 'CNY',
  'SGD', 'CHF', 'AED', 'NZD', 'ZAR', 'BRL', 'MXN',
];

// Approximate fallback rates (relative to 1 USD), used when live rates
// have never been fetched or a refresh fails (e.g. offline).
export const FALLBACK_RATES = {
  USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.3, JPY: 149.5, AUD: 1.52,
  CAD: 1.36, CNY: 7.24, SGD: 1.34, CHF: 0.88, AED: 3.67, NZD: 1.64,
  ZAR: 18.4, BRL: 5.1, MXN: 17.0,
};

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function getRates(rateState) {
  return (rateState && rateState.values) ? rateState.values : FALLBACK_RATES;
}

export function convert(amount, from, to, rates) {
  if (from === to) return amount;
  const table = rates || FALLBACK_RATES;
  const fromRate = table[from] ?? 1;
  const toRate = table[to] ?? 1;
  return (amount / fromRate) * toRate;
}

export async function fetchLiveRates() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error('Rate service returned an error');
  const data = await res.json();
  if (!data || data.result !== 'success' || !data.rates) {
    throw new Error('Unexpected rate payload');
  }
  return data.rates;
}

export function formatMoney(amount, currencyCode) {
  const value = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currencyCode}`;
  }
}
