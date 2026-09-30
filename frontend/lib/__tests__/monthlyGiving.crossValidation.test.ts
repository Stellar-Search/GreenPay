import fc from "fast-check";
import { formatInTimeZone } from "date-fns-tz";
import * as frontendSchedule from "@/lib/monthlyGiving";

/**
 * True cross-validation: both engines are loaded into the SAME test process
 * and run against IDENTICAL inputs, asserting byte-for-byte equal outputs.
 *
 * This is deliberately different from monthlyGiving.test.ts's and
 * recurringSchedule.test.js's "cross-implementation agreement fixtures",
 * which are two independently hand-typed lists of expected values — if
 * someone edits one list without the other, or both implementations drift
 * in the same direction, those tests can still pass. Here there is no
 * hand-typed "expected" value at all for most cases: the backend's output
 * IS the expected value the frontend is checked against, and vice versa.
 *
 * The backend module lives in a sibling workspace (backend/) that isn't
 * guaranteed to be present when frontend/ is built or tested in isolation
 * (e.g. the frontend Docker image's build context only includes frontend/,
 * shared/, and config/). Load it defensively so an isolated build/test run
 * skips this suite instead of crashing.
 */
function loadBackendSchedule() {
  try {
    return require("../../../backend/src/utils/recurringSchedule.js");
  } catch {
    return null;
  }
}

const backendSchedule = loadBackendSchedule();
const describeCrossValidation = backendSchedule ? describe : describe.skip;

const TIME_ZONES = ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata"];

function zonedYearMonthDay(iso: string, timeZone: string) {
  const [year, month, day] = formatInTimeZone(new Date(iso), timeZone, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  return { year, month: month - 1, day };
}

describeCrossValidation("cross-validation: frontend/lib/monthlyGiving.ts vs backend/src/utils/recurringSchedule.js", () => {
  test("expose identical constants", () => {
    expect(frontendSchedule.CHARGE_LOCAL_HOUR).toBe(backendSchedule.CHARGE_LOCAL_HOUR);
    expect(frontendSchedule.DEFAULT_TIME_ZONE).toBe(backendSchedule.DEFAULT_TIME_ZONE);
  });

  test("daysInMonth / clampDayToMonth agree for every month, including leap years", () => {
    for (let year = 2019; year <= 2031; year++) {
      for (let month = 0; month < 12; month++) {
        expect(frontendSchedule.daysInMonth(year, month)).toBe(backendSchedule.daysInMonth(year, month));
        for (let day = 28; day <= 31; day++) {
          expect(frontendSchedule.clampDayToMonth(year, month, day)).toBe(
            backendSchedule.clampDayToMonth(year, month, day),
          );
        }
      }
    }
  });

  test("computeInitialChargeDate agrees across month lengths, leap years, and time zones (property-based)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2019, max: 2031 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 31 }),
        fc.constantFrom(...TIME_ZONES),
        (year, month, rawDay, timeZone) => {
          const day = frontendSchedule.clampDayToMonth(year, month, rawDay);
          const startDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

          const front = frontendSchedule.computeInitialChargeDate(startDate, timeZone);
          const back = backendSchedule.computeInitialChargeDate(startDate, timeZone);

          expect(front.nextDueDate).toBe(back.nextDueDate);
          expect(front.anchorDay).toBe(back.anchorDay);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("computeNextChargeDate agrees for a single hop across month lengths, leap years, and DST-observing/non-DST time zones (property-based)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2019, max: 2031 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 28, max: 31 }),
        fc.constantFrom(...TIME_ZONES),
        fc.integer({ min: 1, max: 6 }),
        (year, month, anchorDay, timeZone, monthsToAdvance) => {
          const startDay = frontendSchedule.clampDayToMonth(year, month, anchorDay);
          const startDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;

          const frontInitial = frontendSchedule.computeInitialChargeDate(startDate, timeZone);
          const backInitial = backendSchedule.computeInitialChargeDate(startDate, timeZone);
          expect(frontInitial.nextDueDate).toBe(backInitial.nextDueDate);

          const frontNext = frontendSchedule.computeNextChargeDate({
            fromIso: frontInitial.nextDueDate,
            anchorDay,
            timeZone,
            monthsToAdvance,
          });
          const backNext = backendSchedule.computeNextChargeDate({
            fromIso: backInitial.nextDueDate,
            anchorDay,
            timeZone,
            monthsToAdvance,
          });

          expect(frontNext).toBe(backNext);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("agree across a 5-year chained schedule for every (anchorDay, timeZone) combination, including clamping restoration through every February", () => {
    const anchorDays = [28, 29, 30, 31];

    for (const anchorDay of anchorDays) {
      for (const timeZone of TIME_ZONES) {
        const startDate = `2023-${String(((anchorDay - 1) % 12) + 1).padStart(2, "0")}-01`;
        let frontIso = frontendSchedule.computeInitialChargeDate(startDate, timeZone).nextDueDate;
        let backIso = backendSchedule.computeInitialChargeDate(startDate, timeZone).nextDueDate;
        expect(frontIso).toBe(backIso);

        for (let cycle = 0; cycle < 60; cycle++) {
          frontIso = frontendSchedule.computeNextChargeDate({
            fromIso: frontIso,
            anchorDay,
            timeZone,
            monthsToAdvance: 1,
          });
          backIso = backendSchedule.computeNextChargeDate({
            fromIso: backIso,
            anchorDay,
            timeZone,
            monthsToAdvance: 1,
          });

          expect(frontIso).toBe(backIso);

          // While we're here: confirm clamping restoration actually happens
          // on both engines in lockstep, not just that they agree with each
          // other (two engines could agree while both being wrong).
          const { year, month } = zonedYearMonthDay(frontIso, timeZone);
          expect(zonedYearMonthDay(frontIso, timeZone).day).toBe(
            frontendSchedule.clampDayToMonth(year, month, anchorDay),
          );
        }
      }
    }
  });

  test("agree on the exact Jan 31 -> Feb -> Mar clamping-restoration regression across every zone", () => {
    for (const timeZone of TIME_ZONES) {
      const anchorDay = 31;
      let frontIso = frontendSchedule.computeInitialChargeDate("2024-01-31", timeZone).nextDueDate;
      let backIso = backendSchedule.computeInitialChargeDate("2024-01-31", timeZone).nextDueDate;
      const frontDays: number[] = [zonedYearMonthDay(frontIso, timeZone).day];
      const backDays: number[] = [zonedYearMonthDay(backIso, timeZone).day];

      for (let i = 0; i < 13; i++) {
        frontIso = frontendSchedule.computeNextChargeDate({ fromIso: frontIso, anchorDay, timeZone, monthsToAdvance: 1 });
        backIso = backendSchedule.computeNextChargeDate({ fromIso: backIso, anchorDay, timeZone, monthsToAdvance: 1 });
        frontDays.push(zonedYearMonthDay(frontIso, timeZone).day);
        backDays.push(zonedYearMonthDay(backIso, timeZone).day);
      }

      expect(frontDays).toEqual(backDays);
      // Feb (index 1) must clamp, and Mar (index 2) must be restored to 31 -
      // proving neither engine permanently degrades the anchor.
      expect(frontDays[1]).toBeLessThan(31);
      expect(frontDays[2]).toBe(31);
    }
  });

  test("agree across DST spring-forward/fall-back transitions (America/New_York, Europe/London) and a non-DST control (Asia/Kolkata)", () => {
    const cases: Array<{ timeZone: string; startDate: string; anchorDay: number }> = [
      { timeZone: "America/New_York", startDate: "2024-01-10", anchorDay: 10 },
      { timeZone: "Europe/London", startDate: "2023-12-29", anchorDay: 29 },
      { timeZone: "Asia/Kolkata", startDate: "2024-01-10", anchorDay: 10 },
    ];

    for (const { timeZone, startDate, anchorDay } of cases) {
      let frontIso = frontendSchedule.computeInitialChargeDate(startDate, timeZone).nextDueDate;
      let backIso = backendSchedule.computeInitialChargeDate(startDate, timeZone).nextDueDate;
      expect(frontIso).toBe(backIso);

      for (let i = 0; i < 24; i++) {
        frontIso = frontendSchedule.computeNextChargeDate({ fromIso: frontIso, anchorDay, timeZone, monthsToAdvance: 1 });
        backIso = backendSchedule.computeNextChargeDate({ fromIso: backIso, anchorDay, timeZone, monthsToAdvance: 1 });

        expect(frontIso).toBe(backIso);
        // Both engines must keep the donor-local wall clock time fixed
        // across DST boundaries, not just agree with each other.
        expect(formatInTimeZone(new Date(frontIso), timeZone, "HH:mm")).toBe(
          `0${frontendSchedule.CHARGE_LOCAL_HOUR}:00`,
        );
      }
    }
  });
});
