import { DeviceType } from '../common/constants/enums';
import {
  inspectFirmwareMarkers,
  readFirmwareMarkers,
  resolveFirmwareIdentity,
} from './firmware-marker.helper';

/** ESP32 obraziga o'xshash bufer: 0xE9 + tasodifiy baytlar + belgilar. */
function fakeBin(...marks: string[]): Buffer {
  const noise = Buffer.from([0xe9, 0x03, 0x02, 0x20, 0xff, 0x00, 0x81, 0x7f]);
  const parts: Buffer[] = [noise];
  for (const mark of marks) {
    parts.push(Buffer.from([0x00, 0xfe]), Buffer.from(mark, 'latin1'));
  }
  parts.push(Buffer.from([0x00, 0x00, 0xc3]));
  return Buffer.concat(parts);
}

describe('readFirmwareMarkers', () => {
  it('ANDIJON versiya va modul belgisini topadi', () => {
    const markers = readFirmwareMarkers(
      fakeBin('ANDIJON_FW_VERSION=2.1.0;', 'ANDIJON_FW_MODULE=kotyol;'),
    );
    expect(markers.versions).toEqual([{ prefix: 'ANDIJON', version: '2.1.0' }]);
    expect(markers.modules).toEqual(['kotyol']);
  });

  it('eski prefikslar ham o‘qiladi (umumiy ifoda)', () => {
    const markers = readFirmwareMarkers(fakeBin('XONOBOD_FW_VERSION=2.0.0;'));
    expect(markers.versions).toEqual([{ prefix: 'XONOBOD', version: '2.0.0' }]);
    expect(markers.modules).toEqual([]);
  });
});

describe('resolveFirmwareIdentity', () => {
  it('ANDIJON_FW_VERSION + ANDIJON_FW_MODULE=xona → xona 1.1.0 (belgidan)', () => {
    const id = resolveFirmwareIdentity(
      readFirmwareMarkers(
        fakeBin('ANDIJON_FW_VERSION=1.1.0;', 'ANDIJON_FW_MODULE=xona;'),
      ),
      undefined,
    );
    expect(id).toEqual({
      version: '1.1.0',
      deviceType: DeviceType.XONA,
      typeSource: 'marker',
      prefix: 'ANDIJON',
    });
  });

  it('⚠️ ANDIJON belgisi eski belgidan USTUN', () => {
    const id = resolveFirmwareIdentity(
      readFirmwareMarkers(
        fakeBin(
          'XONOBOD_FW_VERSION=2.0.0;',
          'ANDIJON_FW_VERSION=2.1.0;',
          'ANDIJON_FW_MODULE=kotyol;',
        ),
      ),
      null,
    );
    expect(id.version).toBe('2.1.0');
    expect(id.deviceType).toBe(DeviceType.KOTYOL);
  });

  it('⚠️ belgi xona, yuklovchi kotyol tanlagan — RAD', () => {
    expect(() =>
      resolveFirmwareIdentity(
        readFirmwareMarkers(
          fakeBin('ANDIJON_FW_VERSION=1.1.0;', 'ANDIJON_FW_MODULE=xona;'),
        ),
        DeviceType.KOTYOL,
      ),
    ).toThrow(/xona/);
  });

  it('belgisiz eski fayl — tur tanlanmasa RAD (taklif bilan)', () => {
    expect(() =>
      resolveFirmwareIdentity(
        readFirmwareMarkers(fakeBin('XONOBOD_FW_VERSION=2.0.0;')),
        undefined,
      ),
    ).toThrow(/qo‘lda tanlang.*kotyol/);
  });

  it('belgisiz eski fayl + qo‘lda kotyol → manual', () => {
    const id = resolveFirmwareIdentity(
      readFirmwareMarkers(fakeBin('XONOBOD_FW_VERSION=2.0.0;')),
      DeviceType.KOTYOL,
    );
    expect(id.typeSource).toBe('manual');
    expect(id.deviceType).toBe(DeviceType.KOTYOL);
  });

  it('⚠️ XONA_FW_VERSION li faylni kotyol deb yuklab bo‘lmaydi', () => {
    expect(() =>
      resolveFirmwareIdentity(
        readFirmwareMarkers(fakeBin('XONA_FW_VERSION=1.0.0;')),
        DeviceType.KOTYOL,
      ),
    ).toThrow(/xona/);
  });

  it('kiritilgan versiya belgiga zid — RAD', () => {
    expect(() =>
      resolveFirmwareIdentity(
        readFirmwareMarkers(
          fakeBin('ANDIJON_FW_VERSION=2.1.0;', 'ANDIJON_FW_MODULE=kotyol;'),
        ),
        undefined,
        '2.1.1',
      ),
    ).toThrow(/mos emas/);
  });

  it('noma‘lum modul so‘zi — RAD', () => {
    expect(() =>
      resolveFirmwareIdentity(
        readFirmwareMarkers(
          fakeBin('ANDIJON_FW_VERSION=2.1.0;', 'ANDIJON_FW_MODULE=boiler;'),
        ),
        undefined,
      ),
    ).toThrow(/Noma‘lum modul/);
  });

  it('belgi yo‘q — RAD', () => {
    expect(() =>
      resolveFirmwareIdentity(
        readFirmwareMarkers(fakeBin()),
        DeviceType.KOTYOL,
      ),
    ).toThrow(/versiya belgisi topilmadi/);
  });
});

describe('inspectFirmwareMarkers — taklif', () => {
  it.each([
    ['XONA_FW_VERSION=1.0.0;', DeviceType.XONA],
    ['XONOBOD_FW_VERSION=2.0.0;', DeviceType.KOTYOL],
    ['FOO_FW_VERSION=1.4.2;', DeviceType.XONA],
    ['FOO_FW_VERSION=2.3.0;', DeviceType.KOTYOL],
  ])('%p → %p', (mark, expected) => {
    const inspected = inspectFirmwareMarkers(
      readFirmwareMarkers(fakeBin(mark)),
    );
    expect(inspected.needsManualType).toBe(true);
    expect(inspected.suggestedType).toBe(expected);
  });
});
