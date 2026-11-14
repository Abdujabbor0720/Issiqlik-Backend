import { BoilerStatus } from '../common/constants/enums';
import { resolveBoilerStatus } from './boiler-status.helper';

const TH = {
  activeMinC: 50,
  mediumMinC: 40,
  criticalMinC: 20,
  offlineAfterMinutes: 15,
};

const now = new Date('2026-11-13T10:00:00Z');
const fresh = new Date('2026-11-13T09:55:00Z');
const stale = new Date('2026-11-13T09:30:00Z');

describe('resolveBoilerStatus', () => {
  it('50 °C va undan yuqori — faol', () => {
    expect(
      resolveBoilerStatus({ temperature: 50, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.ACTIVE);
    expect(
      resolveBoilerStatus({ temperature: 72.5, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.ACTIVE);
  });

  it('40–50 °C — o‘rta', () => {
    expect(
      resolveBoilerStatus({ temperature: 40, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.MEDIUM);
    expect(
      resolveBoilerStatus({ temperature: 49.9, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.MEDIUM);
  });

  it('20–40 °C — ishlamayotgan', () => {
    expect(
      resolveBoilerStatus({ temperature: 20, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.INACTIVE);
    expect(
      resolveBoilerStatus({ temperature: 39.9, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.INACTIVE);
  });

  it('20 °C dan past — sovuq, ya’ni offline', () => {
    expect(
      resolveBoilerStatus({ temperature: 12, lastReadingAt: fresh, now }, TH),
    ).toBe(BoilerStatus.OFFLINE);
  });

  it('ESKIRGAN o‘lchov issiq bo‘lsa ham — aloqa yo‘q', () => {
    expect(
      resolveBoilerStatus({ temperature: 80, lastReadingAt: stale, now }, TH),
    ).toBe(BoilerStatus.OFFLINE);
  });

  it('hech qachon signal kelmagan — aloqa yo‘q', () => {
    expect(
      resolveBoilerStatus({ temperature: null, lastReadingAt: null, now }, TH),
    ).toBe(BoilerStatus.OFFLINE);
  });
});
