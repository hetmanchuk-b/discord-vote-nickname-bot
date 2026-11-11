export const REPUTATION_TIME_ZONE = 'Europe/Kyiv';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPUTATION_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function kyivDate(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid date.');
  const parts = formatter.formatToParts(at);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function calendarDate(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Expected a YYYY-MM-DD calendar date.');
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid calendar date.');
  }
  return date;
}

export function nextCalendarDate(day: string): string {
  const date = calendarDate(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// Find the first instant belonging to the local date, using the runtime's IANA
// timezone data. No fixed UTC offset or 24-hour-day assumption (DST-safe).
function localDayStart(day: string): Date {
  const nominal = calendarDate(day).getTime();
  let low = nominal - 36 * 60 * 60_000;
  let high = nominal + 36 * 60 * 60_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (kyivDate(new Date(middle)) < day) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}

export interface KyivDay {
  day: string;
  start: Date;
  end: Date;
}

export function kyivDay(day: string): KyivDay {
  return { day, start: localDayStart(day), end: localDayStart(nextCalendarDate(day)) };
}

export function nextKyivMidnight(at: Date): Date {
  return localDayStart(nextCalendarDate(kyivDate(at)));
}
