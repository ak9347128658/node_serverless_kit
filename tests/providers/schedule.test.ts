import { describe, expect, it } from "vitest";
import { ScheduleEvent } from "../../src/config/schema.js";
import * as s from "../../src/providers/schedule.js";

const ev = (raw: Record<string, unknown>) => ScheduleEvent.parse(raw);

describe("rates", () => {
  it.each([
    ["1 minute", [1, "minute"]],
    ["5 Minutes", [5, "minute"]],
    [" 2 hours ", [2, "hour"]],
    ["1 day", [1, "day"]],
  ])("parseRate(%j)", (rate, expected) => {
    expect(s.parseRate(rate)).toEqual(expected);
  });

  it("parseRate rejects bad input", () => {
    expect(() => s.parseRate("often")).toThrow(s.ScheduleError);
    expect(() => s.parseRate("0 minutes")).toThrow("rate must be positive");
    expect(() => s.parseRate("5 weeks")).toThrow(/invalid rate/);
  });

  it.each([
    ["1 minute", "* * * * *"],
    ["5 minutes", "*/5 * * * *"],
    ["30 minutes", "*/30 * * * *"],
    ["60 minutes", "0 * * * *"],
    ["120 minutes", "0 */2 * * *"],
    ["1440 minutes", "0 0 * * *"],
    ["1 hour", "0 * * * *"],
    ["6 hours", "0 */6 * * *"],
    ["24 hours", "0 0 * * *"],
    ["48 hours", "0 0 */2 * *"],
    ["1 day", "0 0 * * *"],
    ["7 days", "0 0 */7 * *"],
    ["31 days", "0 0 */31 * *"],
  ])("rateToCron(%j) = %j", (rate, cron) => {
    expect(s.rateToCron(rate)).toBe(cron);
  });

  it.each(["7 minutes", "90 minutes", "5 hours", "36 hours", "45 days"])("rateToCron(%j) is not expressible", (rate) => {
    expect(() => s.rateToCron(rate)).toThrow(s.ScheduleError);
  });

  it("toCron5 and toSeconds", () => {
    expect(s.toCron5(ev({ cron: "  0   1 * *  * " }))).toBe("0 1 * * *");
    expect(s.toCron5(ev({ rate: "15 minutes" }))).toBe("*/15 * * * *");
    expect(s.toSeconds(ev({ rate: "2 hours" }))).toBe(7200);
    expect(s.toSeconds(ev({ rate: "3 days" }))).toBe(259200);
    expect(s.toSeconds(ev({ rate: "1 minute" }))).toBe(60);
    expect(() => s.toSeconds(ev({ cron: "* * * * *" }))).toThrow(s.ScheduleError);
  });
});

describe("AWS", () => {
  it.each([
    [{ rate: "1 minute" }, "rate(1 minute)"],
    [{ rate: "10 minutes" }, "rate(10 minutes)"],
    [{ rate: "1 hour" }, "rate(1 hour)"],
    [{ rate: "2 days" }, "rate(2 days)"],
    [{ rate: "7 minutes" }, "rate(7 minutes)"],
    [{ cron: "0 12 * * *" }, "cron(0 12 * * ? *)"],
    [{ cron: "0 12 * * 1-5" }, "cron(0 12 ? * 2-6 *)"],
    [{ cron: "30 8 * * 0,6" }, "cron(30 8 ? * 1,7 *)"],
    [{ cron: "0 0 * * 7" }, "cron(0 0 ? * 1 *)"],
    [{ cron: "0 0 * * 1-5/2" }, "cron(0 0 ? * 2-6/2 *)"],
    [{ cron: "0 0 1 * *" }, "cron(0 0 1 * ? *)"],
    [{ cron: "0 9 * * MON" }, "cron(0 9 ? * MON *)"],
    [{ cron: "0 9 * * MON-FRI" }, "cron(0 9 ? * MON-FRI *)"],
    [{ cron: "*/15 * * 1 *" }, "cron(*/15 * * 1 ? *)"],
  ])("%j -> %s", (raw, expected) => {
    expect(s.awsExpression(ev(raw))).toBe(expected);
  });

  it("rejects day-of-month and day-of-week together", () => {
    expect(() => s.awsExpression(ev({ cron: "0 0 1 * 1" }))).toThrow(/both day-of-month and day-of-week/);
  });
});

describe("other dialects", () => {
  it("ncrontab (Azure)", () => {
    expect(s.ncrontab(ev({ rate: "5 minutes" }))).toBe("0 */5 * * * *");
    expect(s.ncrontab(ev({ rate: "2 hours" }))).toBe("0 0 */2 * * *");
    expect(s.ncrontab(ev({ cron: "0 2 * * *" }))).toBe("0 0 2 * * *");
  });

  it("6- and 7-field cron, @every", () => {
    expect(s.cronWithSeconds(ev({ rate: "5 minutes" }))).toBe("0 */5 * * * *");
    expect(s.cronWithSeconds(ev({ cron: "30 1 * * 0" }))).toBe("0 30 1 * * 0");
    expect(s.tencentCron(ev({ cron: "0 2 * * *" }))).toBe("0 0 2 * * * *");
    expect(s.everyExpression(ev({ rate: "5 minutes" }))).toBe("@every 5m");
    expect(s.everyExpression(ev({ rate: "2 hours" }))).toBe("@every 2h");
    expect(s.everyExpression(ev({ rate: "1 day" }))).toBe("@every 1d");
    expect(() => s.everyExpression(ev({ cron: "* * * * *" }))).toThrow(/require `rate`/);
  });

  it.each([
    [{ cron: "0 9 * * 1" }, "0 9 * * MON"],
    [{ cron: "0 9 * * 0,6" }, "0 9 * * SUN,SAT"],
    [{ cron: "0 9 * * 7" }, "0 9 * * SUN"],
    [{ cron: "0 9 * * 1-5" }, "0 9 * * MON-FRI"],
    [{ cron: "0 9 * * */2" }, "0 9 * * */2"],
    [{ cron: "0 9 * * TUE" }, "0 9 * * TUE"],
    [{ rate: "1 day" }, "0 0 * * *"],
  ])("namedCron5(%j) = %s", (raw, expected) => {
    expect(s.namedCron5(ev(raw))).toBe(expected);
  });
});
