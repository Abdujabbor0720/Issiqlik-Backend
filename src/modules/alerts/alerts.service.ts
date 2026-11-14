import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AlertSeverity,
  AlertState,
  AlertType,
  BoilerStatus,
  ProbeKind,
} from '../../common/constants/enums';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Alert } from '../../database/entities/alert.entity';
import { isUniqueViolation } from '../../helpers/db-errors.helper';
import { temperatureDelta } from '../../helpers/probe-reading.helper';
import { applyDistrictScope } from '../../helpers/scope.helper';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsService } from '../settings/settings.service';
import type { AlertQueryDto } from './dto/alert.dto';

export interface EvaluateInput {
  boilerId: string;
  lotNumber: string;
  status: BoilerStatus;
  /** CHIQISH harorati — `null` bo'lsa, chiqish datchigi qiymat bermagan. */
  temperature: number | null;
  now: Date;

  /*
   * ─────────── Ikki datchikli qurilmalar uchun (ixtiyoriy) ───────────
   * ⚠️ IXTIYORIY va bu ongli: holat kuzatuvchisi cron'i
   * (`status-watcher.job.ts`) faqat ALOQA yo'qligini baholaydi va
   * datchik juftligi haqida hech narsa bilmaydi. Majburiy bo'lsa,
   * u yerda ma'nosiz qiymatlar to'qib yozishga to'g'ri kelardi.
   */

  /** KIRISH (obratka) harorati. */
  inletTemperature?: number | null;
  /** O'lchovda qaysi datchik qatnashgani. */
  probe?: ProbeKind;
  /** Sirkulyatsiya chegarasi, °C (sozlamadan). */
  minDeltaC?: number;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @InjectRepository(Alert) private readonly repo: Repository<Alert>,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * HOLATGA QARAB OGOHLANTIRISHNI OCHISH / YOPISH.
   *
   * ⚠️⚠️ HAR O'LCHOVDA YANGI QATOR YOZILMAYDI. Bitta sovuq kotyol har
   * 30 soniyada signal yuborsa, kuniga 2880 ta bir xil ogohlantirish
   * paydo bo'lardi va ro'yxat butunlay o'qilmas holga kelardi.
   * Buning o'rniga bitta OCHIQ qator yuritiladi: muammo davom etsa
   * `lastSeenAt` yangilanadi, holat tiklansa qator YOPILADI.
   *
   * ⚠️ Shu tufayli «hozir nechta muammo bor» degan savolga aniq javob
   * bor: `state = open` bo'lgan qatorlar soni.
   */
  async evaluate(input: EvaluateInput): Promise<void> {
    const settings = await this.settings.get();
    const type = this.typeFor(input, settings.overheatC);

    // Muammo yo'q — ochiq ogohlantirishlar yopiladi.
    if (!type) {
      await this.resolveOpen(input.boilerId, input.now);
      return;
    }

    const existing = await this.repo.findOne({
      where: { boilerId: input.boilerId, type, state: AlertState.OPEN },
    });

    if (existing) {
      /*
       * ⚠️ Faqat `lastSeenAt` va harorat yangilanadi. `createdAt` ga
       * TEGILMAYDI: «qachondan beri davom etmoqda» degan savolga javob
       * aynan shu maydonda va u har signalda siljisa, muammo abadiy
       * «hozirgina boshlandi» bo'lib turardi.
       */
      await this.repo.update(existing.id, {
        lastSeenAt: input.now,
        temperature: input.temperature,
      });
      return;
    }

    /*
     * ⚠️ Yangi turdagi muammo ochilganda ESKI turdagilari YOPILADI:
     * kotyol «sovuq» dan «aloqa yo'q» ga o'tsa, ikkala ogohlantirish
     * bir vaqtda ochiq turib, bitta kotyol ikki marta sanalardi.
     */
    await this.resolveOpen(input.boilerId, input.now, type);

    const alert = await this.repo.save(
      this.repo.create({
        boilerId: input.boilerId,
        type,
        severity: this.severityFor(type),
        state: AlertState.OPEN,
        message: this.messageFor(type, input),
        temperature: input.temperature,
        lastSeenAt: input.now,
      }),
    );

    this.realtime.emitAlert({
      alertId: alert.id,
      boilerId: alert.boilerId,
      lotNumber: input.lotNumber,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      at: input.now.toISOString(),
    });
  }

  /**
   * XONALAR BO'YICHA OGOHLANTIRISH — bitta binoning hamma xonasi birdan.
   *
   * ⚠️⚠️ KOTYOL OGOHLANTIRISHIDAN TUBDAN FARQLI: u yerda bitta kotyolda
   * bitta muammo (yangisi eskisini almashtiradi), bu yerda esa HAR XONA
   * MUSTAQIL — 3 ta xona bir vaqtda sovuq bo'lishi mumkin va uchalasi
   * ham ro'yxatda turishi kerak.
   *
   * ⚠️ Ochiq xona ogohlantirishlari BITTA so'rov bilan o'qiladi, har
   * xona uchun alohida emas: qurilma har daqiqada 10 xonani yuboradi,
   * 2000 binoda bu sekundiga yuzlab ortiqcha so'rov bo'lardi.
   *
   * ⚠️ XATO TASHLAMAYDI deb hisoblanmaydi — chaqiruvchi (telemetriya)
   * uni o'zi yutadi: ogohlantirish YON TA'SIR, o'lchov esa saqlangan.
   */
  async evaluateRooms(input: {
    boilerId: string;
    lotNumber: string;
    minC: number;
    now: Date;
    rooms: Array<{
      roomId: string;
      roomName: string;
      temperature: number;
      /** `true` — minimumdan past VA xona nazoratda. */
      cold: boolean;
    }>;
  }): Promise<void> {
    if (input.rooms.length === 0) return;

    const open = await this.repo.find({
      where: {
        boilerId: input.boilerId,
        type: AlertType.ROOM_COLD,
        state: In([AlertState.OPEN, AlertState.ACKNOWLEDGED]),
        roomId: In(input.rooms.map((room) => room.roomId)),
      },
      select: { id: true, roomId: true },
    });
    const openByRoom = new Map(open.map((alert) => [alert.roomId, alert.id]));

    const toResolve: string[] = [];

    for (const room of input.rooms) {
      const existingId = openByRoom.get(room.roomId);

      if (!room.cold) {
        if (existingId) toResolve.push(existingId);
        continue;
      }

      if (existingId) {
        // ⚠️ `createdAt` ga TEGILMAYDI — «qachondan beri sovuq» shunda.
        await this.repo.update(existingId, {
          lastSeenAt: input.now,
          temperature: room.temperature,
        });
        continue;
      }

      const message =
        `Lot ${input.lotNumber}: «${room.roomName}» sovuq — ` +
        `${room.temperature.toFixed(1)} °C (eng past ruxsat: ${input.minC} °C)`;

      try {
        const alert = await this.repo.save(
          this.repo.create({
            boilerId: input.boilerId,
            roomId: room.roomId,
            type: AlertType.ROOM_COLD,
            severity: this.severityFor(AlertType.ROOM_COLD),
            state: AlertState.OPEN,
            message: message.slice(0, 400),
            temperature: room.temperature,
            lastSeenAt: input.now,
          }),
        );

        this.realtime.emitAlert({
          alertId: alert.id,
          boilerId: alert.boilerId,
          lotNumber: input.lotNumber,
          type: alert.type,
          severity: alert.severity,
          message: alert.message,
          at: input.now.toISOString(),
        });
      } catch (error) {
        /*
         * ⚠️ Poyga: parallel so'rov AYNI xona uchun qatorni allaqachon
         * yozib qo'ydi (`UQ_alerts_open_per_room`). Natija kerakli —
         * ochiq ogohlantirish bor. Qolgan xonalar baholanishda davom
         * etadi; bitta xonadagi poyga ularni to'xtatmasligi kerak.
         */
        if (!isUniqueViolation(error)) throw error;
      }
    }

    if (toResolve.length > 0) {
      await this.repo.update(
        { id: In(toResolve) },
        { state: AlertState.RESOLVED, resolvedAt: input.now },
      );
    }
  }

  /**
   * BITTA XONANING OCHIQ OGOHLANTIRISHLARINI YOPISH.
   *
   * ⚠️ Xona «nazoratdan chiqarilganda» (qozonxona xonasi, ta'mir)
   * chaqiriladi: keyingi signalni kutmasdan yopiladi, aks holda admin
   * «nazoratda emas» deb belgilagan xona ro'yxatda «sovuq» bo'lib
   * turaverardi.
   */
  async resolveRoom(roomId: string, now: Date): Promise<void> {
    await this.repo.update(
      {
        roomId,
        state: In([AlertState.OPEN, AlertState.ACKNOWLEDGED]),
      },
      { state: AlertState.RESOLVED, resolvedAt: now },
    );
  }

  /**
   * ESKIRGAN XONALARNING OGOHLANTIRISHLARINI YOPISH (cron).
   *
   * ⚠️⚠️ Datchigi uzilgan xonaning «sovuq» xabari ABADIY ochiq
   * qolmasligi kerak: biz u haqida endi HECH NARSA bilmaymiz. «Sovuq»
   * deb turaversa, operator u yerga borib, xona issiq ekanini ko'rib
   * qaytardi va keyingi xabarlarga ishonmay qo'yardi. Aloqa yo'qligi
   * esa kotyol darajasida o'z ogohlantirishi (`offline`) bilan aytiladi.
   *
   * @returns Yopilgan ogohlantirishlar soni.
   */
  async resolveStaleRooms(staleBefore: Date, now: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Alert)
      .set({ state: AlertState.RESOLVED, resolvedAt: now })
      .where('room_id IS NOT NULL')
      .andWhere('state IN (:...states)', {
        states: [AlertState.OPEN, AlertState.ACKNOWLEDGED],
      })
      .andWhere(
        `room_id IN (SELECT id FROM rooms
                     WHERE last_reading_at IS NULL OR last_reading_at < :staleBefore)`,
        { staleBefore },
      )
      .execute();
    return result.affected ?? 0;
  }

  async list(
    query: AlertQueryDto,
    user?: AuthUser,
  ): Promise<PaginatedResult<Alert>> {
    const qb = this.repo
      .createQueryBuilder('alert')
      .innerJoin('alert.boiler', 'boiler')
      .addSelect([
        'boiler.id',
        'boiler.lotNumber',
        'boiler.address',
        'boiler.districtId',
        'boiler.lastTemperature',
      ])
      .leftJoin('boiler.district', 'district')
      .addSelect(['district.id', 'district.name', 'district.shortName'])
      .leftJoin('boiler.organization', 'organization')
      .addSelect(['organization.id', 'organization.name'])
      .leftJoin('alert.acknowledgedBy', 'ackUser')
      .addSelect(['ackUser.id', 'ackUser.fullName'])
      // Xona ogohlantirishida — qaysi xona (kotyolnikida `null`).
      .leftJoin('alert.room', 'room')
      .addSelect(['room.id', 'room.name'])
      /*
       * ⚠️ Tartib: avval OG'IRLIK, keyin vaqt. Vaqt bo'yicha saralansa,
       * yangi «harorat past» ogohlantirishi bir soat oldingi «butun
       * qozonxona sovuq» xabarini pastga surib yuborardi.
       *
       * ⚠️⚠️ `DESC` — bu POSTGRESQL ENUM TARTIBI, alifbo emas.
       * `alerts_severity_enum` migratsiyada `('info','warning','critical')`
       * tartibida e'lon qilingan va PostgreSQL enum'ni aynan shu
       * E'LON TARTIBIDA saralaydi; `DESC` esa eng og'irini (critical)
       * birinchi qo'yadi.
       *
       * ⚠️ Bu yerda `CASE ... END` ifodasi ISHLATILMAYDI: `skip`/`take`
       * bilan birga TypeORM ichki DISTINCT so'rovini quradi va
       * `orderBy` dagi xom ifodani ALIAS deb o'qiydi —
       * «"CASE alert" alias was not found» xatosi bilan butun endpoint
       * 500 qaytarardi. Enum tartibi esa hech qanday ifoda talab
       * qilmaydi.
       */
      .orderBy('alert.severity', 'DESC')
      .addOrderBy('alert.createdAt', 'DESC')
      .skip(query.skip)
      .take(query.limit);

    applyDistrictScope(qb, user, 'boiler.district_id');

    if (query.states?.length) {
      qb.andWhere('alert.state IN (:...states)', { states: query.states });
    } else {
      // ⚠️ Sukut bo'yicha FAQAT ochiqlar: yopilganlar bilan birga
      // ko'rsatilsa, ro'yxat tarixga aylanib, «hozir nima bo'lyapti»
      // degan savolga javob bermasdi.
      qb.andWhere('alert.state IN (:...states)', {
        states: [AlertState.OPEN, AlertState.ACKNOWLEDGED],
      });
    }
    if (query.types?.length) {
      qb.andWhere('alert.type IN (:...types)', { types: query.types });
    }
    if (query.severity) {
      qb.andWhere('alert.severity = :severity', { severity: query.severity });
    }
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }
    if (query.search) {
      qb.andWhere(
        '(boiler.lot_number ILIKE :q OR organization.name ILIKE :q OR alert.message ILIKE :q)',
        { q: `%${query.search}%` },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResult(items, total, query.page, query.limit);
  }

  async acknowledge(id: string, note: string, actor: AuthUser): Promise<Alert> {
    const alert = await this.repo.findOne({ where: { id } });
    if (!alert) throw new NotFoundException('Ogohlantirish topilmadi');

    await this.repo.update(id, {
      state: AlertState.ACKNOWLEDGED,
      acknowledgedAt: new Date(),
      acknowledgedById: actor.id,
      ackNote: note,
    });

    return this.repo.findOneOrFail({ where: { id } });
  }

  /**
   * Ochiq ogohlantirishi BOR kotyollar identifikatorlari.
   *
   * ⚠️ Holat kuzatuvchisi (`StatusWatcherJob`) uchun: u har daqiqada
   * 2000 ta kotyol uchun `evaluate()` chaqirmasligi kerak — sog'lom
   * kotyolda bu bekorga UPDATE bo'lardi. Bitta so'rov bilan «kimda
   * ochiq muammo bor» ni bilib olib, qolganlariga tegilmaydi.
   */
  async openBoilerIds(): Promise<Set<string>> {
    const rows = await this.repo
      .createQueryBuilder('alert')
      .select('DISTINCT alert.boiler_id', 'boilerId')
      .where('alert.state IN (:...states)', {
        states: [AlertState.OPEN, AlertState.ACKNOWLEDGED],
      })
      // ⚠️ Faqat kotyol ogohlantirishlari: xonaniki `evaluate()` ga tegishli emas.
      .andWhere('alert.room_id IS NULL')
      .getRawMany<{ boilerId: string }>();
    return new Set(rows.map((row) => row.boilerId));
  }

  /** Ochiq ogohlantirishlar soni — dashboard kartasi uchun. */
  async openCount(user?: AuthUser): Promise<number> {
    const qb = this.repo
      .createQueryBuilder('alert')
      .innerJoin('alert.boiler', 'boiler')
      .where('alert.state = :state', { state: AlertState.OPEN });
    applyDistrictScope(qb, user, 'boiler.district_id');
    return qb.getCount();
  }

  // ───────────────── ichki ─────────────────

  /**
   * QAYSI MUAMMO HAQIDA XABAR BERISH.
   *
   * ⚠️⚠️ BIR VAQTDA BITTA ogohlantirish bo'ladi (`resolveOpen` eski
   * turdagilarni yopadi), shuning uchun TARTIB — bu MUHIMLIK
   * tartibi. Noto'g'ri tartib eng muhim xabarni ko'rinmas qilib
   * qo'yardi.
   */
  private typeFor(input: EvaluateInput, overheatC: number): AlertType | null {
    /*
     * ⚠️⚠️ 1. DATCHIK NOSOZ — ENG BIRINCHI. Chiqish datchigi qiymat
     * bermasa, harorat NOMA'LUM: «sovuq» deb xabar berish YOLG'ON
     * bo'lardi (kotyol 90 °C da ham bo'lishi mumkin) va ta'mirchi
     * noto'g'ri joyni qidirardi. Bu holatda qilinadigan ish ham
     * boshqa: modemni emas, DATCHIKNI almashtirish kerak.
     *
     * ⚠️ Faqat `probe` AYTILGANDA ishlaydi: `probe === INLET` degani
     * «kirish o'qildi, chiqish o'qilmadi». Oddiy aloqa yo'qligida
     * `probe` umuman kelmaydi va bu shart o'tmaydi — ya'ni
     * «aloqa yo'q» xabari o'z o'rnida qolaveradi.
     */
    if (input.probe === ProbeKind.INLET) {
      return AlertType.SENSOR_FAULT;
    }

    // ⚠️ 2. Ortiqcha qizish — xavfsizlik masalasi, haroratdan oldin.
    if (
      input.temperature !== null &&
      input.temperature >= overheatC &&
      input.status !== BoilerStatus.OFFLINE
    ) {
      return AlertType.OVERHEAT;
    }

    // ⚠️ 3. Aloqa yo'q / sovuq / past harorat — asosiy holat qoidasi.
    switch (input.status) {
      case BoilerStatus.OFFLINE:
        return AlertType.OFFLINE;
      case BoilerStatus.INACTIVE:
        return AlertType.CRITICAL_TEMPERATURE;
      case BoilerStatus.MEDIUM:
        return AlertType.LOW_TEMPERATURE;
      default:
        break;
    }

    /*
     * ⚠️⚠️ 4. SUV AYLANMAYAPTI — ENG OXIRIDA va faqat holat
     * «faol» bo'lganda (yuqoridagi `switch` dan o'tib kelgan).
     *
     * Mantiq: kotyol ISSIQ (shuning uchun yuqoridagi shartlar
     * o'tmadi), lekin kirish va chiqish harorati deyarli TENG —
     * demak suv quvurda turib qolgan va issiqlik binoga bormayapti.
     *
     * ⚠️ Sovuq kotyolda bu tekshiruv O'TKAZILMAYDI: u yerda ayirma
     * baribir nolga yaqin bo'ladi va asosiy muammo «sovuq». Agar
     * tartib teskari bo'lsa, har bir sovuq kotyol «sirkulyatsiya
     * yo'q» deb xabar berib, haqiqiy sababni yashirardi.
     *
     * ⚠️ Faqat `BOTH` da ishlaydi: bitta datchik bilan ayirmani
     * hisoblab bo'lmaydi.
     */
    if (
      input.probe === ProbeKind.BOTH &&
      input.minDeltaC !== undefined &&
      input.minDeltaC > 0
    ) {
      const delta = temperatureDelta(
        input.inletTemperature ?? null,
        input.temperature,
      );
      /*
       * ⚠️ `Math.abs` ISHLATILADI: datchiklar teskari ulangan bo'lsa,
       * ayirma manfiy bo'ladi (masalan −18 °C). Uning MODULI katta,
       * ya'ni suv aylanayapti — faqat simlar almashtirilgan. Modulsiz
       * tekshiruvda −18 < 3 bo'lib, sog'lom qozonxona «sirkulyatsiya
       * yo'q» deb xabar berardi.
       */
      if (delta !== null && Math.abs(delta) < input.minDeltaC) {
        return AlertType.NO_CIRCULATION;
      }
    }

    return null;
  }

  private severityFor(type: AlertType): AlertSeverity {
    switch (type) {
      case AlertType.OFFLINE:
      case AlertType.CRITICAL_TEMPERATURE:
      case AlertType.OVERHEAT:
        return AlertSeverity.CRITICAL;
      /*
       * ⚠️⚠️ `NO_CIRCULATION` — KRITIK. Tashqi ko'rinishi «hammasi
       * yaxshi» bo'lgani uchun uni ogohlantirishlar ro'yxatida pastga
       * qo'yish eng xavfli qaror bo'lardi: bino sovuq, ko'rsatkichlar
       * esa yashil. Aynan shu holatda operator darhol bilishi kerak.
       */
      case AlertType.NO_CIRCULATION:
        return AlertSeverity.CRITICAL;
      case AlertType.LOW_TEMPERATURE:
        return AlertSeverity.WARNING;
      /*
       * ⚠️ `SENSOR_FAULT` — OGOHLANTIRISH, kritik EMAS. Kotyol
       * ehtimol normal ishlayapti; muammo o'lchashda. Kritik
       * qilinsa, u haqiqiy avariyalar bilan bir qatorda turib,
       * kechasi operatorni behuda uyg'otardi.
       */
      case AlertType.SENSOR_FAULT:
        return AlertSeverity.WARNING;
      /*
       * ⚠️ `ROOM_COLD` — OGOHLANTIRISH. Bitta sovuq xona — butun
       * qozonxona to'xtashi emas; kritik bo'lsa, u «kotyol ishlamayapti»
       * xabarlari bilan bir qatorga chiqib, ularni ko'mib yuborardi.
       */
      case AlertType.ROOM_COLD:
        return AlertSeverity.WARNING;
      default:
        return AlertSeverity.INFO;
    }
  }

  private messageFor(type: AlertType, input: EvaluateInput): string {
    const temp =
      input.temperature === null ? '—' : `${input.temperature.toFixed(1)} °C`;

    switch (type) {
      case AlertType.OFFLINE:
        return input.temperature === null
          ? `Lot ${input.lotNumber}: qurilmadan signal kelmayapti`
          : `Lot ${input.lotNumber}: kotyol sovuq (${temp})`;
      case AlertType.CRITICAL_TEMPERATURE:
        return `Lot ${input.lotNumber}: kotyol ishlamayapti — ${temp}`;
      case AlertType.LOW_TEMPERATURE:
        return `Lot ${input.lotNumber}: harorat me'yordan past — ${temp}`;
      case AlertType.OVERHEAT:
        return `Lot ${input.lotNumber}: ortiqcha qizish — ${temp}`;
      /*
       * ⚠️ Xabar matni AYNAN QILINADIGAN ISHNI aytadi. «Datchik
       * nosoz» deb qo'yish kamlik qiladi: qaysi datchik va nima
       * qilish kerakligi yozilmasa, ta'mirchi joyiga borib yana
       * telefon qilardi.
       */
      case AlertType.SENSOR_FAULT:
        return (
          `Lot ${input.lotNumber}: CHIQISH datchigi qiymat bermayapti — ` +
          'harorat noma‘lum, datchikni tekshirish kerak' +
          (input.inletTemperature !== null &&
          input.inletTemperature !== undefined
            ? ` (kirish: ${input.inletTemperature.toFixed(1)} °C)`
            : '')
        );
      case AlertType.NO_CIRCULATION: {
        const delta = temperatureDelta(
          input.inletTemperature ?? null,
          input.temperature,
        );
        return (
          `Lot ${input.lotNumber}: suv aylanmayapti — kirish va chiqish ` +
          `harorati deyarli teng (ayirma ${delta === null ? '—' : delta.toFixed(1)} °C, ` +
          `chiqish ${temp}). Nasos yoki ventilni tekshirish kerak`
        );
      }
      default:
        return `Lot ${input.lotNumber}: holat o‘zgardi`;
    }
  }

  /** Ochiq ogohlantirishlarni yopish. `exceptType` — yangi ochilgani. */
  private async resolveOpen(
    boilerId: string,
    now: Date,
    exceptType?: AlertType,
  ): Promise<void> {
    const qb = this.repo
      .createQueryBuilder()
      .update(Alert)
      .set({ state: AlertState.RESOLVED, resolvedAt: now })
      .where('boiler_id = :boilerId', { boilerId })
      .andWhere('state IN (:...states)', {
        states: [AlertState.OPEN, AlertState.ACKNOWLEDGED],
      })
      /*
       * ⚠️⚠️ FAQAT KOTYOL OGOHLANTIRISHLARI. Bu shart bo'lmasa, kotyol
       * aloqasi tiklangan zahoti «1-sinf sovuq» xabari ham YOPILARDI —
       * holbuki xona hamon sovuq. Xona ogohlantirishlarini faqat
       * `evaluateRooms()` yopadi.
       */
      .andWhere('room_id IS NULL');

    if (exceptType) qb.andWhere('type <> :exceptType', { exceptType });
    await qb.execute();
  }
}
