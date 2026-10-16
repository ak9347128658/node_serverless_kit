/**
 * Convert the portable schedule syntax into each provider's dialect.
 *
 * The config accepts:
 *
 * - `rate: "<n> minutes|hours|days"`
 * - `cron: "<min> <hour> <day-of-month> <month> <day-of-week>"` (standard 5-field unix cron)
 */

import { RATE_RE, type ScheduleEvent } from "../config/schema.js";

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export type RateUnit = "minute" | "hour" | "day";

export function parseRate(rate: string): [number, RateUnit] {
  const m = RATE_RE.exec(rate);
  if (!m) throw new ScheduleError(`invalid rate '${rate}'`);
  const value = Number(m[1]);
  const unit = m[2].toLowerCase().replace(/s$/, "") as RateUnit;
  if (value <= 0) throw new ScheduleError("rate must be positive");
  return [value, unit];
}

/** Best-effort conversion of a rate to standard 5-field cron. */
export function rateToCron(rate: string): string {
  const [value, unit] = parseRate(rate);
  if (unit === "minute") {
    if (value < 60 && 60 % value === 0) return value === 1 ? "* * * * *" : `*/${value} * * * *`;
    if (value % 60 === 0) return rateToCron(`${value / 60} hours`);
    throw new ScheduleError(`rate '${rate}' is not expressible as cron; use a divisor of 60 minutes`);
  }
  if (unit === "hour") {
    if (value < 24 && 24 % value === 0) return value === 1 ? "0 * * * *" : `0 */${value} * * *`;
    if (value % 24 === 0) return rateToCron(`${value / 24} days`);
    throw new ScheduleError(`rate '${rate}' is not expressible as cron; use a divisor of 24 hours`);
  }
  if (value === 1) return "0 0 * * *";
  if (value <= 31) return `0 0 */${value} * *`;
  throw new ScheduleError(`rate '${rate}' is too long for cron`);
}

export function toCron5(ev: ScheduleEvent): string {
  return ev.cron ? ev.cron.trim().split(/\s+/).join(" ") : rateToCron(ev.rate ?? "");
}

export function toSeconds(ev: ScheduleEvent): number {
  const [value, unit] = parseRate(ev.rate ?? "");
  return value * { minute: 60, hour: 3600, day: 86400 }[unit];
}

// ----------------------------------------------------------------- dialects

function mapDow(field: string, conv: (token: string) => string): string {
  return field
    .split(",")
    .map((part) => {
      const slash = part.indexOf("/");
      const base = slash >= 0 ? part.slice(0, slash) : part;
      const step = slash >= 0 ? part.slice(slash) : "";
      const dash = base.indexOf("-");
      const mapped = dash >= 0 ? `${conv(base.slice(0, dash))}-${conv(base.slice(dash + 1))}` : conv(base);
      return mapped + step;
    })
    .join(",");
}

/** unix 0-6 (Sun=0) -> AWS 1-7 (Sun=1). Names pass through. */
function awsDow(field: string): string {
  return mapDow(field, (t) => (/^\d+$/.test(t) ? String((Number(t) % 7) + 1) : t));
}

export function awsExpression(ev: ScheduleEvent): string {
  if (ev.rate) {
    const [value, unit] = parseRate(ev.rate);
    return `rate(${value} ${unit}${value === 1 ? "" : "s"})`;
  }
  let [minute, hour, dom, month, dow] = toCron5(ev).split(" ");
  if (dow !== "*" && dom === "*") {
    dom = "?";
    dow = awsDow(dow);
  } else if (dow !== "*" && dom !== "*") {
    throw new ScheduleError("AWS cron cannot restrict both day-of-month and day-of-week");
  } else {
    dow = "?";
  }
  return `cron(${minute} ${hour} ${dom} ${month} ${dow} *)`;
}

/** Azure Functions timer trigger (NCRONTAB): 6 fields, seconds first. */
export function ncrontab(ev: ScheduleEvent): string {
  if (ev.rate) {
    const [value, unit] = parseRate(ev.rate);
    if (unit === "minute" && value < 60) return `0 */${value} * * * *`;
  }
  return "0 " + toCron5(ev);
}

/** Alibaba / Huawei style 6-field cron (seconds first). */
export function cronWithSeconds(ev: ScheduleEvent): string {
  return "0 " + toCron5(ev);
}

/** Tencent SCF: 7 fields, seconds first, year last. */
export function tencentCron(ev: ScheduleEvent): string {
  return "0 " + toCron5(ev) + " *";
}

/** `@every 5m` style used by Alibaba FC and Huawei FunctionGraph. */
export function everyExpression(ev: ScheduleEvent): string {
  if (!ev.rate) throw new ScheduleError("@every expressions require `rate`");
  const [value, unit] = parseRate(ev.rate);
  return `@every ${value}${unit[0]}`;
}

const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * Standard 5-field cron with numeric day-of-week replaced by SUN..SAT.
 * Clouds disagree on numeric weekdays (0=Sun vs 1=Sun); names are unambiguous.
 */
export function namedCron5(ev: ScheduleEvent): string {
  const [minute, hour, dom, month, dow] = toCron5(ev).split(" ");
  const named = mapDow(dow, (t) => (/^\d+$/.test(t) ? DOW_NAMES[Number(t) % 7] : t));
  return [minute, hour, dom, month, named].join(" ");
}
