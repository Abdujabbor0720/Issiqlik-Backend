import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditAction } from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import { Room, RoomReading } from '../../database/entities/room.entity';
import {
  classifyRoomTemperature,
  isRoomReadingFresh,
  shouldLogRoomReading,
  type RoomSample,
} from '../../helpers/room-reading.helper';
import {
  applyDistrictScope,
  assertDistrictAccess,
} from '../../helpers/scope.helper';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import type {
  BoilerRoomsView,
  RoomHistorySeries,
  RoomsSummary,
  RoomView,
  UpdateRoomDto,
} from './dto/room.dto';

/**
 * BITTA BINODAGI XONALAR CHEGARASI.
 *
 * ⚠️ Avtomatik yaratish bor ekan, chegara SHART: buzuq proshivka har
 * signalda yangi kalit yuborsa, bir kechada minglab «xona» paydo
 * bo'lardi. 64 — eng katta maktab uchun ham yetarli zaxira.
 */
export const MAX_ROOMS_PER_BOILER = 64;

export interface RoomIngestInput {
  boilerId: string;
  lotNumber: string;
  samples: RoomSample[];
  recordedAt: Date;
  now: Date;
}

export interface RoomIngestResult {
  /** Joriy qiymati yangilangan xonalar. */
  updated: number;
  /** Avtomatik yaratilgan xonalar. */
  created: number;
  /** Chegara (`MAX_ROOMS_PER_BOILER`) tufayli yaratilmagan kalitlar. */
  overCap: number;
}

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    @InjectRepository(Room) private readonly rooms: Repository<Room>,
    @InjectRepository(RoomReading)
    private readonly readings: Repository<RoomReading>,
    @InjectRepository(Boiler) private readonly boilers: Repository<Boiler>,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
  ) {}

  // ════════════════════════ TELEMETRIYA ════════════════════════

  /**
   * QURILMADAN KELGAN XONA O'LCHOVLARINI QABUL QILISH.
   *
   * Ketma-ketlik:
   *   1) noma'lum kalitlar uchun xona AVTOMATIK yaratiladi («Xona N»);
   *   2) joriy qiymat BITTA `UPDATE` bilan yoziladi (eskirgani o'tkazib
   *      yuboriladi);
   *   3) tarixga faqat `room_sample_minutes` o'tgan xonalar yoziladi;
   *   4) sovuq xonalar uchun ogohlantirish ochiladi / yopiladi.
   *
   * ⚠️⚠️ Chaqiruvchi (telemetriya) bu funksiyaning XATOSINI YUTADI:
   * kotyol o'lchovi allaqachon saqlangan. Xatoni qurilmaga qaytarish uni
   * AYNI o'lchovni qayta-qayta yuborishga majburlardi.
   */
  async ingest(input: RoomIngestInput): Promise<RoomIngestResult> {
    const result: RoomIngestResult = { updated: 0, created: 0, overCap: 0 };
    if (input.samples.length === 0) return result;

    const keys = input.samples.map((sample) => sample.key);
    let rooms = await this.findByKeys(input.boilerId, keys);

    // ───────── 1. Avtomatik yaratish ─────────
    const known = new Set(rooms.map((room) => room.sensorKey));
    const missing = keys.filter((key) => !known.has(key));

    if (missing.length > 0) {
      const existing = await this.rooms.count({
        where: { boilerId: input.boilerId },
      });
      const capacity = Math.max(0, MAX_ROOMS_PER_BOILER - existing);
      const toCreate = missing.slice(0, capacity);
      result.overCap = missing.length - toCreate.length;

      if (result.overCap > 0) {
        this.logger.warn(
          `Lot ${input.lotNumber}: xonalar chegarasi (${MAX_ROOMS_PER_BOILER}) ` +
            `to‘ldi — ${result.overCap} ta yangi datchik e‘tiborsiz qoldirildi`,
        );
      }

      if (toCreate.length > 0) {
        /*
         * ⚠️⚠️ `ON CONFLICT DO NOTHING` (`orIgnore`). Qurilma javobni
         * olmasa AYNI yukni qayta yuboradi va ikki so'rov parallel
         * kelishi mumkin. Yagona indeks (`UQ_rooms_boiler_sensor`)
         * ikkinchi xonani yaratmaydi, bu yerda esa xato KO'TARILMAYDI.
         *
         * ⚠️ Nom «Xona N» — tartib raqami bilan. Nomlar yagona EMAS
         * (poyga ikkita «Xona 3» berishi mumkin) va bu xavfsiz: xona
         * kalit bilan aniqlanadi, nom esa admin uni qayta nomlaguncha
         * vaqtinchalik yorliq.
         */
        await this.rooms
          .createQueryBuilder()
          .insert()
          .into(Room)
          .values(
            toCreate.map((key, index) => ({
              boilerId: input.boilerId,
              sensorKey: key,
              name: `Xona ${existing + index + 1}`,
              sortOrder: existing + index + 1,
              isAutoCreated: true,
            })),
          )
          .orIgnore()
          .execute();

        rooms = await this.findByKeys(input.boilerId, keys);
        result.created = rooms.length - known.size;
      }
    }

    // ───────── 2–3. Joriy qiymat va tarix ─────────
    const settings = await this.settings.get();
    const byKey = new Map(rooms.map((room) => [room.sensorKey, room]));

    const candidates: Array<{ room: Room; temperature: number; log: boolean }> =
      [];
    for (const sample of input.samples) {
      const room = byKey.get(sample.key);
      if (!room) continue;

      /*
       * ⚠️ ESKIRGAN O'LCHOV (oflayn navbatdan) JORIY QIYMATNI
       * O'ZGARTIRMAYDI — kotyoldagi qoida bilan AYNI. Aks holda 3 soat
       * oldingi «22 °C» hozir sovib qolgan xonani «iliq» qilib
       * ko'rsatardi. Xom qiymat baribir `telemetry_readings.raw_payload`
       * da saqlangan va yo'qolmaydi.
       */
      if (
        room.lastReadingAt &&
        room.lastReadingAt.getTime() >= input.recordedAt.getTime()
      ) {
        continue;
      }

      candidates.push({
        room,
        temperature: sample.temperature,
        log: shouldLogRoomReading(
          room.lastLoggedAt,
          input.recordedAt,
          settings.roomSampleMinutes,
        ),
      });
    }
    if (candidates.length === 0) return result;

    const updatedIds = await this.writeCurrent(candidates, input.recordedAt);
    result.updated = updatedIds.size;
    if (updatedIds.size === 0) return result;

    const winners = candidates.filter((item) => updatedIds.has(item.room.id));

    const toLog = winners.filter((item) => item.log);
    if (toLog.length > 0) {
      await this.readings.insert(
        toLog.map((item) => ({
          roomId: item.room.id,
          temperature: item.temperature,
          recordedAt: input.recordedAt,
        })),
      );
    }

    // ───────── 4. Ogohlantirish ─────────
    /*
     * ⚠️ XATO YUTILADI — ogohlantirish YON TA'SIR. Joriy qiymat va
     * tarix allaqachon yozilgan; bu yerdagi xato qurilmaga yetib
     * borsa, u o'lchovni qayta yuborardi.
     */
    try {
      await this.alerts.evaluateRooms({
        boilerId: input.boilerId,
        lotNumber: input.lotNumber,
        minC: settings.roomMinC,
        now: input.now,
        rooms: winners.map((item) => ({
          roomId: item.room.id,
          roomName: item.room.name,
          temperature: item.temperature,
          cold:
            item.room.isMonitored &&
            classifyRoomTemperature(item.temperature, {
              minC: settings.roomMinC,
              normC: settings.roomNormC,
            }) === 'cold',
        })),
      });
    } catch (error) {
      this.logger.warn(
        `Xona ogohlantirishi yozilmadi (lot ${input.lotNumber}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    return result;
  }

  /**
   * JORIY QIYMATLARNI BITTA SO'ROVDA YOZISH.
   *
   * ⚠️⚠️ NIMA UCHUN XOM SQL. Qurilma har daqiqada ~10 xonani yuboradi;
   * har xona uchun alohida `UPDATE` 2000 binoda sekundiga 300+ so'rov
   * bo'lardi. `UPDATE … FROM (VALUES …)` hammasini bitta so'rovda
   * yozadi.
   *
   * ⚠️ `WHERE last_reading_at < :recordedAt` — o'qish va yozish
   * orasida parallel so'rov yangiroq qiymat yozgan bo'lsa, u BOSIB
   * KETILMAYDI (kotyoldagi qoida bilan AYNI). Faqat haqiqatan
   * yangilangan qatorlar qaytadi — tarix va ogohlantirish faqat
   * ular uchun.
   *
   * @returns Haqiqatan yangilangan xonalar identifikatorlari.
   */
  private async writeCurrent(
    items: Array<{ room: Room; temperature: number; log: boolean }>,
    recordedAt: Date,
  ): Promise<Set<string>> {
    const params: unknown[] = [];
    const tuples = items.map((item) => {
      params.push(item.room.id, item.temperature, item.log);
      const base = params.length - 2;
      return `($${base}::uuid, $${base + 1}::numeric, $${base + 2}::boolean)`;
    });
    params.push(recordedAt);
    const at = `$${params.length}::timestamptz`;

    const raw: unknown = await this.rooms.manager.query(
      `UPDATE "rooms" AS r
          SET "last_temperature" = v.t,
              "last_reading_at"  = ${at},
              "last_logged_at"   = CASE WHEN v.log THEN ${at}
                                        ELSE r."last_logged_at" END,
              "updated_at"       = now()
         FROM (VALUES ${tuples.join(', ')}) AS v(id, t, log)
        WHERE r."id" = v.id
          AND (r."last_reading_at" IS NULL OR r."last_reading_at" < ${at})
        RETURNING r."id" AS id`,
      params,
    );

    /*
     * ⚠️ TypeORM (PostgreSQL) `UPDATE … RETURNING` uchun `[rows, count]`
     * qaytaradi, boshqa buyruqlar uchun esa `rows`. Ikkala shakl ham
     * qabul qilinadi — drayver yangilanganda jimgina «hech narsa
     * yangilanmadi» bo'lib qolmasligi uchun.
     */
    const rows = (
      Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw
    ) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  private findByKeys(boilerId: string, keys: string[]): Promise<Room[]> {
    return this.rooms.find({
      where: { boilerId, sensorKey: In(keys) },
    });
  }

  /**
   * ESKI XONA TARIXINI TOZALASH — kotyol telemetriyasi bilan AYNI muddat.
   *
   * ⚠️ Partiyalab (10 000 tadan): bitta katta `DELETE` jadvalni uzoq
   * bloklab, o'sha paytda kelgan signallarni kutdirib qo'yardi.
   * `IDX_room_readings_recorded_at` indeksi shu so'rov uchun.
   */
  async purgeOld(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    let deleted = 0;
    for (let batch = 0; batch < 50; batch += 1) {
      const result = await this.readings
        .createQueryBuilder()
        .delete()
        .where(
          'id IN (SELECT id FROM room_readings WHERE recorded_at < :cutoff LIMIT 10000)',
          { cutoff },
        )
        .execute();
      const affected = result.affected ?? 0;
      deleted += affected;
      if (affected === 0) break;
    }
    return deleted;
  }

  // ════════════════════════ KABINET ════════════════════════

  /**
   * Kotyolning xonalari — joriy holat va CHEGARALAR bilan.
   *
   * ⚠️ Chegaralar shu javobda: tuman mas'ulida `settings.view` YO'Q,
   * lekin grafikdagi «me'yor» va «eng past» chiziqlarini u ham
   * ko'rishi kerak. Alohida ruxsat bermaslik uchun — shu yerda.
   */
  async listForBoiler(
    boilerId: string,
    user?: AuthUser,
  ): Promise<BoilerRoomsView> {
    await this.assertBoilerVisible(boilerId, user);

    const [rooms, settings] = await Promise.all([
      this.rooms.find({
        where: { boilerId },
        order: { sortOrder: 'ASC', name: 'ASC' },
      }),
      this.settings.get(),
    ]);
    const now = new Date();
    const thresholds = { minC: settings.roomMinC, normC: settings.roomNormC };

    return {
      thresholds,
      rooms: rooms.map((room) =>
        this.toView(room, now, settings.offlineAfterMinutes, thresholds),
      ),
    };
  }

  /** Xonalar tarixi — grafik uchun. */
  async history(
    boilerId: string,
    hours: number,
    user?: AuthUser,
  ): Promise<RoomHistorySeries[]> {
    await this.assertBoilerVisible(boilerId, user);

    const rooms = await this.rooms.find({
      where: { boilerId },
      order: { sortOrder: 'ASC', name: 'ASC' },
      select: { id: true, name: true },
    });
    if (rooms.length === 0) return [];

    const from = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.readings
      .createQueryBuilder('reading')
      .select(['reading.roomId', 'reading.temperature', 'reading.recordedAt'])
      .where('reading.room_id IN (:...ids)', { ids: rooms.map((r) => r.id) })
      .andWhere('reading.recorded_at >= :from', { from })
      .orderBy('reading.recorded_at', 'ASC')
      .getMany();

    const byRoom = new Map<string, RoomHistorySeries>(
      rooms.map((room) => [
        room.id,
        { roomId: room.id, name: room.name, points: [] },
      ]),
    );
    for (const row of rows) {
      byRoom.get(row.roomId)?.points.push({
        t: row.temperature,
        at: row.recordedAt.toISOString(),
      });
    }
    return [...byRoom.values()];
  }

  async update(
    id: string,
    dto: UpdateRoomDto,
    actor: AuthUser,
  ): Promise<RoomView> {
    const room = await this.findWithBoiler(id);
    assertDistrictAccess(actor, room.boiler.districtId);

    const before = {
      name: room.name,
      note: room.note,
      sortOrder: room.sortOrder,
      isMonitored: room.isMonitored,
    };

    // ⚠️ Maydonma-maydon: `Object.assign` `undefined` ni ham ko'chirardi.
    if (dto.name !== undefined) room.name = dto.name;
    if (dto.note !== undefined) room.note = dto.note || null;
    if (dto.sortOrder !== undefined) room.sortOrder = dto.sortOrder;
    if (dto.isMonitored !== undefined) room.isMonitored = dto.isMonitored;
    /*
     * ⚠️ Nom berilgan zahoti xona «avtomatik» belgisini yo'qotadi:
     * kabinetda «nomlanmagan xonalar» ro'yxati admin ishini ko'rsatadi
     * va nomlangan xona unda qolib ketmasligi kerak.
     */
    if (dto.name !== undefined) room.isAutoCreated = false;

    /*
     * ⚠️⚠️ `save()` EMAS, `update()` — FAQAT tahrirlanadigan ustunlar.
     * `save()` o'qilgan qatorning HAMMA ustunini qaytarib yozadi, shu
     * jumladan `last_temperature` / `last_reading_at`. Admin xonani
     * nomlayotgan soniyada telemetriya yangi haroratni yozgan bo'lsa,
     * u eski qiymat bilan BOSIB KETILARDI va xona «o'tmishga» qaytardi.
     */
    const boiler = room.boiler;
    await this.rooms.update(room.id, {
      name: room.name,
      note: room.note,
      sortOrder: room.sortOrder,
      isMonitored: room.isMonitored,
      isAutoCreated: room.isAutoCreated,
    });

    /*
     * ⚠️ Nazoratdan chiqarilgan xonaning ochiq ogohlantirishi DARHOL
     * yopiladi — keyingi signalni kutmasdan.
     */
    if (before.isMonitored && !room.isMonitored) {
      await this.alerts.resolveRoom(room.id, new Date());
    }

    await this.audit.log({
      actor,
      action: AuditAction.UPDATE,
      entityName: 'Room',
      entityId: room.id,
      summary: `Xona tahrirlandi: lot ${boiler.lotNumber} — ${room.name}`,
      before,
      after: {
        name: room.name,
        note: room.note,
        sortOrder: room.sortOrder,
        isMonitored: room.isMonitored,
      },
    });

    const settings = await this.settings.get();
    return this.toView(room, new Date(), settings.offlineAfterMinutes, {
      minC: settings.roomMinC,
      normC: settings.roomNormC,
    });
  }

  /**
   * XONANI O'CHIRISH — tarixi va ogohlantirishlari bilan (CASCADE).
   *
   * ⚠️ Datchik hamon yuborayotgan bo'lsa, xona keyingi signalda
   * «Xona N» bo'lib QAYTADI. Bu to'g'ri: o'chirish — xato yaratilgan
   * yoki olib tashlangan datchikni tozalash uchun. Ishlab turgan
   * datchikni yashirish uchun «nazoratdan chiqarish» bor.
   */
  async remove(id: string, actor: AuthUser): Promise<void> {
    const room = await this.findWithBoiler(id);
    assertDistrictAccess(actor, room.boiler.districtId);

    await this.rooms.delete(room.id);
    await this.audit.log({
      actor,
      action: AuditAction.DELETE,
      entityName: 'Room',
      entityId: room.id,
      summary: `Xona o‘chirildi: lot ${room.boiler.lotNumber} — ${room.name}`,
      before: { name: room.name, sensorKey: room.sensorKey },
    });
  }

  /**
   * DASHBOARD: VILOYAT (yoki tuman) BO'YICHA XONALAR HOLATI.
   *
   * ⚠️⚠️ Faqat NAZORATDAGI va DOLZARB o'lchovli xonalar o'rtachaga
   * kiradi. Datchigi bir hafta oldin uzilgan xona oxirgi «22 °C» bilan
   * o'rtachani ko'tarib, «hamma xona iliq» degan yolg'on manzara
   * berardi. Eskirganlar alohida sanaladi (`stale`) — yashirilmaydi.
   *
   * ⚠️ Hammasi BITTA agregat so'rovda: kartadagi «sovuq + salqin +
   * me'yorda = o'lchangan» qo'shilmasi BIR LAHZADAGI holatdan chiqishi
   * shart (dashboard kotyol kartalari bilan AYNI qoida).
   */
  async summary(
    user: AuthUser | undefined,
    districtIds?: string[],
  ): Promise<RoomsSummary> {
    const settings = await this.settings.get();
    const freshAfter = new Date(
      Date.now() - settings.offlineAfterMinutes * 60_000,
    );
    const params = {
      freshAfter,
      minC: settings.roomMinC,
      normC: settings.roomNormC,
    };
    const fresh =
      'room.last_reading_at >= :freshAfter AND room.last_temperature IS NOT NULL';

    const qb = this.rooms
      .createQueryBuilder('room')
      .innerJoin('room.boiler', 'boiler')
      .select(`COUNT(*) FILTER (WHERE ${fresh})`, 'measured')
      .addSelect(`COUNT(*) FILTER (WHERE NOT (${fresh}))`, 'stale')
      .addSelect(`AVG(room.last_temperature) FILTER (WHERE ${fresh})`, 'avg')
      .addSelect(`MIN(room.last_temperature) FILTER (WHERE ${fresh})`, 'min')
      .addSelect(
        `COUNT(*) FILTER (WHERE ${fresh} AND room.last_temperature < :minC)`,
        'cold',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ${fresh} AND room.last_temperature >= :minC
                            AND room.last_temperature < :normC)`,
        'cool',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ${fresh} AND room.last_temperature >= :normC)`,
        'normal',
      )
      .addSelect(
        `COUNT(DISTINCT room.boiler_id) FILTER (WHERE ${fresh}
                                                AND room.last_temperature < :minC)`,
        'buildingsWithCold',
      )
      .where('room.is_monitored = true')
      .andWhere('boiler.is_archived = false')
      .setParameters(params);

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', { districtIds });
    }

    const coldestQb = this.rooms
      .createQueryBuilder('room')
      .innerJoin('room.boiler', 'boiler')
      .innerJoin('boiler.district', 'district')
      .leftJoin('boiler.organization', 'organization')
      .select([
        'room.id AS "roomId"',
        'room.name AS "roomName"',
        'room.last_temperature AS temperature',
        'boiler.id AS "boilerId"',
        'boiler.lot_number AS "lotNumber"',
        'organization.name AS "organizationName"',
        'district.name AS "districtName"',
      ])
      .where('room.is_monitored = true')
      .andWhere('boiler.is_archived = false')
      .andWhere(fresh)
      .andWhere('room.last_temperature < :normC')
      .setParameters(params)
      .orderBy('room.last_temperature', 'ASC')
      .limit(10);

    applyDistrictScope(coldestQb, user, 'boiler.district_id');
    if (districtIds?.length) {
      coldestQb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds,
      });
    }

    const [row, coldest] = await Promise.all([
      qb.getRawOne<Record<string, string | null>>(),
      coldestQb.getRawMany<Record<string, unknown>>(),
    ]);

    const round1 = (value: string | null | undefined): number | null =>
      value === null || value === undefined
        ? null
        : Math.round(Number(value) * 10) / 10;

    return {
      measured: Number(row?.measured ?? 0),
      stale: Number(row?.stale ?? 0),
      avg: round1(row?.avg),
      min: round1(row?.min),
      cold: Number(row?.cold ?? 0),
      cool: Number(row?.cool ?? 0),
      normal: Number(row?.normal ?? 0),
      buildingsWithCold: Number(row?.buildingsWithCold ?? 0),
      minC: settings.roomMinC,
      normC: settings.roomNormC,
      coldest: coldest.map((item) => ({
        roomId: String(item.roomId),
        roomName: String(item.roomName),
        temperature: Number(item.temperature),
        boilerId: String(item.boilerId),
        lotNumber: String(item.lotNumber),
        organizationName: (item.organizationName as string | null) ?? null,
        districtName: String(item.districtName),
      })),
    };
  }

  // ════════════════════════ YORDAMCHILAR ════════════════════════

  /**
   * Kotyol foydalanuvchiga KO'RINADIMI.
   *
   * ⚠️ Boshqa tumanning kotyoli uchun 404, 403 EMAS: 403 «bunday
   * kotyol BOR, lekin sizniki emas» degani — ya'ni identifikatorni
   * tanlab ko'rib, boshqa tumanlarda nima borligini bilib olish
   * mumkin bo'lardi. Kotyollar ro'yxati ham shunday ishlaydi.
   */
  private async assertBoilerVisible(
    boilerId: string,
    user?: AuthUser,
  ): Promise<void> {
    const boiler = await this.boilers.findOne({
      where: { id: boilerId },
      select: { id: true, districtId: true },
    });
    if (!boiler) throw new NotFoundException('Kotyol topilmadi');
    try {
      assertDistrictAccess(user, boiler.districtId);
    } catch {
      throw new NotFoundException('Kotyol topilmadi');
    }
  }

  private async findWithBoiler(id: string): Promise<Room> {
    const room = await this.rooms.findOne({
      where: { id },
      relations: { boiler: true },
    });
    if (!room) throw new NotFoundException('Xona topilmadi');
    return room;
  }

  private toView(
    room: Room,
    now: Date,
    offlineAfterMinutes: number,
    thresholds: { minC: number; normC: number },
  ): RoomView {
    const isFresh =
      room.lastTemperature !== null &&
      isRoomReadingFresh(room.lastReadingAt, now, offlineAfterMinutes);

    return {
      id: room.id,
      boilerId: room.boilerId,
      sensorKey: room.sensorKey,
      name: room.name,
      note: room.note,
      sortOrder: room.sortOrder,
      isAutoCreated: room.isAutoCreated,
      isMonitored: room.isMonitored,
      temperature: room.lastTemperature,
      lastReadingAt: room.lastReadingAt?.toISOString() ?? null,
      isFresh,
      /*
       * ⚠️ Eskirgan o'lchovda holat NOMA'LUM (`null`), «oxirgi
       * ma'lum holat» EMAS: bir hafta oldingi «me'yorda» bugungi
       * xonani yashil qilib ko'rsatardi.
       */
      condition:
        isFresh && room.lastTemperature !== null
          ? classifyRoomTemperature(room.lastTemperature, thresholds)
          : null,
    };
  }
}
