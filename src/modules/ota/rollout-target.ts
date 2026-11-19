import type { SelectQueryBuilder } from 'typeorm';
import { RolloutTargetType } from '../../common/constants/enums';
import type { Device } from '../../database/entities/device.entity';
import type { FirmwareRollout } from '../../database/entities/firmware.entities';

/**
 * TARQATISH MAQSADI — `devices` so'roviga (alias `device`) filtr qo'shadi.
 *
 * ⚠️⚠️ YAGONA JOY. Ilgari bu mantiq `OtaService` (qurilmaga taklif) va
 * `FirmwareService` (maqsadlar soni, progress) da NUSXA bo'lib turardi:
 * biri tuzatilib, ikkinchisi qolsa, panel «12 ta qurilma» deb ko'rsatib,
 * aslida boshqa qurilmalarga taklif qilinardi.
 *
 * Qoidalar:
 *   • MODUL TURI — MAJBURIY filtr: reliz turidan boshqa turdagi qurilma
 *     hech qachon maqsad bo'lmaydi (kotyol `.bin` xona platasiga tushmasin);
 *   • faqat faol (`is_active`) qurilmalar;
 *   • tuman va obyekt turi — qurilmaning AMALDAGI joylashuvi bo'yicha:
 *     kotyolga ulangan bo'lsa kotyolniki, aks holda paneldagi o'z
 *     maydonlari (`device.district_id`, `device.organization_id`). Ilgari
 *     faqat kotyolga ulanganlar hisoblanardi va ulanmagan, lekin tumani
 *     tasdiqlangan modul tuman bo'yicha tarqatishdan tushib qolardi.
 *
 * @returns `false` — maqsad ro'yxati bo'sh (so'rov bajarilmasin).
 */
export function applyRolloutTarget(
  qb: SelectQueryBuilder<Device>,
  rollout: Pick<FirmwareRollout, 'deviceType' | 'targetType' | 'targetIds'>,
): boolean {
  qb.andWhere('device.is_active = true').andWhere(
    'device.device_type = :rolloutDeviceType',
    { rolloutDeviceType: rollout.deviceType },
  );

  const ids = rollout.targetIds ?? [];
  switch (rollout.targetType) {
    case RolloutTargetType.ALL:
      return true;

    case RolloutTargetType.DEVICES:
      if (ids.length === 0) return false;
      qb.andWhere('device.id IN (:...rolloutTargetIds)', {
        rolloutTargetIds: ids,
      });
      return true;

    case RolloutTargetType.DISTRICTS:
      if (ids.length === 0) return false;
      qb.leftJoin(
        'boilers',
        'rtBoiler',
        'rtBoiler.id = device.boiler_id',
      ).andWhere(
        'COALESCE(rtBoiler.district_id, device.district_id) IN (:...rolloutTargetIds)',
        { rolloutTargetIds: ids },
      );
      return true;

    case RolloutTargetType.OBJECT_TYPES:
      if (ids.length === 0) return false;
      qb.leftJoin('boilers', 'rtBoiler', 'rtBoiler.id = device.boiler_id')
        .leftJoin(
          'organizations',
          'rtOrg',
          'rtOrg.id = COALESCE(rtBoiler.organization_id, device.organization_id)',
        )
        .andWhere('rtOrg.object_type_id IN (:...rolloutTargetIds)', {
          rolloutTargetIds: ids,
        });
      return true;

    default:
      return false;
  }
}
