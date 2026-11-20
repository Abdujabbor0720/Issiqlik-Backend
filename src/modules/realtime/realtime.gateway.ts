import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { In, Repository } from 'typeorm';
import { UserRole } from '../../common/constants/enums';
import { User } from '../../database/entities/user.entity';

export interface BoilerStatusEvent {
  boilerId: string;
  districtId: string;
  lotNumber: string | null;
  status: string;
  temperature: number | null;
  at: string;
}

export interface AlertEvent {
  alertId: string;
  boilerId: string;
  lotNumber: string | null;
  type: string;
  severity: string;
  message: string;
  at: string;
}

/** XAVF hodisasi — yengil: mijoz to'liq kartani REST dan oladi. */
export interface IncidentRealtimeEvent {
  incidentId: string;
  number: number;
  /** `created` | `updated` | `escalated` | `resolved` | `reopened` | `closed`. */
  change: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  boilerId: string;
  districtId: string;
  agencyId: string | null;
  escalationLevel: number;
  at: string;
}

/** Shaxsiy panel ogohlantirishi (`incident_notifications` qatori). */
export interface NotificationRealtimeEvent {
  notificationId: string;
  incidentId: string;
  number: number;
  title: string;
  severity: string;
  level: number;
  audience: string;
  at: string;
}

/** XAVF xonalari: kim qaysi kesimni tinglaydi. */
export interface IncidentAudience {
  districtId: string;
  agencyId: string | null;
  /** Shaxsan (javobgar hisobi, eskalatsiya oluvchilar). */
  userIds: string[];
}

/** Token bilan ulangan socket haqida (qayta tekshirish uchun). */
interface SocketAuth {
  userId: string;
  /** Token amal qilish muddati, ms. */
  expiresAt: number;
}

/** Autentifikatsiyalangan socketlarni qayta tekshirish oralig'i. */
const REVALIDATE_MS = 60_000;

/** Viloyat darajasidagi rollar — barcha XAVF hodisalari. */
const REGION_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.VIEWER,
];

/**
 * JONLI YANGILANISH.
 *
 * ⚠️ Nega WebSocket, oddiy `setInterval` so'rovi emas: dashboard'da
 * 196 ta kotyol va xarita bor. Har 10 soniyada hammasini qayta
 * so'rash — soatiga 360 ta og'ir agregat so'rovi, ochilgan har bir
 * brauzer oynasi uchun. Hodisa esa faqat HOLAT O'ZGARGANDA keladi va
 * u kuniga bir necha marta bo'ladi.
 *
 * ⚠️ Hodisa YENGIL: faqat identifikator va yangi holat. To'liq obyekt
 * yuborilsa, mijoz ikki xil shakldagi ma'lumot bilan ishlardi — biri
 * REST dan, biri soketdan — va ular bir kuni ajralib ketardi. Mijoz
 * hodisani olib, kerak bo'lsa ro'yxatni yangilaydi.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
  // ⚠️ Transport tartibi: avval `websocket`. `polling` birinchi bo'lsa,
  // har mijoz ulanishni uzoq so'rov bilan boshlab, server ulanish
  // hovuzini bekorga band qilardi.
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private revalidateTimer: NodeJS.Timeout | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    /*
     * ⚠️⚠️ TOKEN BILAN ULANISH — XAVF hodisalari FAQAT shunda keladi.
     * Xona TOKENDAGI emas, BAZADAGI foydalanuvchidan quriladi (rol,
     * tuman, tashkilot): so'rovdagi `districtId` ga ishonilmaydi, aks
     * holda istalgan mijoz boshqa tumanning XAVF larini tinglab olardi
     * (texnik topshiriq §9).
     */
    const token = this.extractToken(client);
    if (token) {
      const result = await this.authenticate(token);
      if (result) {
        (client.data as { auth?: SocketAuth }).auth = {
          userId: result.user.id,
          expiresAt: result.expiresAt,
        };
        void client.join([
          ...this.privilegedRooms(result.user),
          ...this.legacyRooms(result.user),
        ]);
        return;
      }
      // ⚠️ Yaroqsiz token — ULANISH UZILMAYDI (eski xulq), faqat XAVF xonalarisiz.
      client.emit('auth:error', { message: 'Token yaroqsiz yoki eskirgan' });
    }

    /*
     * ⚠️ Mijoz TUMAN XONASIGA qo'shiladi (`district:<id>`). Tuman
     * operatori butun viloyat hodisalarini olmasligi kerak: bu ham
     * ortiqcha tarmoq, ham uning ko'rishi shart bo'lmagan ma'lumot.
     *
     * ⚠️ Bu — ESKI (tokensiz) yo'l, mavjud panel shunday ulanadi va u
     * o'zgarmaydi: bu yerga faqat kotyol holati keladi, XAVF EMAS.
     */
    const districtId = client.handshake.query.districtId;
    if (typeof districtId === 'string' && districtId) {
      void client.join(`district:${districtId}`);
    } else {
      void client.join('region');
    }
  }

  handleDisconnect(client: Socket): void {
    void client;
  }

  /**
   * XAVF HODISASI — faqat VAKOLATLI xonalarga:
   *   • `incidents:region`            — viloyat darajasi;
   *   • `incidents:district:<id>`     — shu tuman mas'ullari;
   *   • `incidents:agency:<id>`       — shu tashkilot mas'ullari;
   *   • `user:<id>`                   — javobgar hisobi va eskalatsiya
   *                                     oluvchilari shaxsan.
   * ⚠️ socket.io bir nechta xonaga yuborishda bitta mijozga bitta nusxa
   * beradi — viloyat admini ikki xonada bo'lsa ham ikki marta olmaydi.
   */
  emitIncident(event: IncidentRealtimeEvent, audience: IncidentAudience): void {
    if (!this.server) return;
    const rooms = [
      'incidents:region',
      `incidents:district:${audience.districtId}`,
      ...(audience.agencyId ? [`incidents:agency:${audience.agencyId}`] : []),
      ...audience.userIds.map((id) => `user:${id}`),
    ];
    this.server.to(rooms).emit('incident:changed', event);
  }

  /** Shaxsiy ogohlantirish — faqat egasiga. */
  emitNotification(userId: string, event: NotificationRealtimeEvent): void {
    if (!this.server) return;
    this.server.to(`user:${userId}`).emit('incident:notification', event);
  }

  // ───────────────── ichki ─────────────────

  /** Token: `auth.token` (socket.io), `Authorization: Bearer …` yoki `?token=`. */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    if (typeof auth?.token === 'string' && auth.token) {
      return auth.token.replace(/^Bearer\s+/i, '');
    }
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
      return header.replace(/^Bearer\s+/i, '');
    }
    const query = client.handshake.query.token;
    return typeof query === 'string' && query ? query : null;
  }

  /**
   * ⚠️ `jwt.strategy.ts` bilan AYNI qoida: faqat ACCESS token, foydalanuvchi
   * BAZADAN va faol bo'lishi shart. Faolsizlantirilgan xodim ochiq qolgan
   * brauzer oynasi orqali XAVF larni tinglashda davom etmasligi kerak.
   */
  private async authenticate(
    token: string,
  ): Promise<{ user: User; expiresAt: number } | null> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        typ: string;
        exp?: number;
      }>(token, { secret: this.config.getOrThrow<string>('jwt.accessSecret') });
      if (payload.typ !== 'access') return null;
      const user = await this.users.findOne({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          districtId: true,
          agencyId: true,
          isActive: true,
        },
      });
      if (!user?.isActive) return null;
      return {
        user,
        expiresAt: payload.exp ? payload.exp * 1000 : Number.MAX_SAFE_INTEGER,
      };
    } catch {
      return null;
    }
  }

  /** XAVF xonalari — vakolat bo'yicha (shaxsiy xona har doim). */
  private privilegedRooms(
    user: Pick<User, 'id' | 'role' | 'districtId' | 'agencyId'>,
  ): string[] {
    const rooms = [`user:${user.id}`];
    if (REGION_ROLES.includes(user.role)) {
      rooms.push('incidents:region');
    } else if (user.role === UserRole.OPERATOR && user.districtId) {
      rooms.push(`incidents:district:${user.districtId}`);
    } else if (user.role === UserRole.AGENCY_OFFICER && user.agencyId) {
      rooms.push(`incidents:agency:${user.agencyId}`);
    }
    // ⚠️ Obyekt javobgari — faqat shaxsiy xona (`user:<id>`).
    return rooms;
  }

  /** Kotyol holati xonasi (eski oqim) — token bo'lsa ham BAZADAGI tumandan. */
  private legacyRooms(user: Pick<User, 'role' | 'districtId'>): string[] {
    if (user.role === UserRole.OPERATOR && user.districtId) {
      return [`district:${user.districtId}`];
    }
    return REGION_ROLES.includes(user.role) ? ['region'] : [];
  }

  afterInit(): void {
    this.revalidateTimer = setInterval(() => {
      this.revalidate().catch((error: unknown) =>
        this.logger.warn(
          'Socket vakolatini qayta tekshirib bo‘lmadi: ' +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
    }, REVALIDATE_MS);
    this.revalidateTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
  }

  /**
   * TOKEN BILAN ULANGANLARNI QAYTA TEKSHIRISH — har daqiqada.
   *
   * ⚠️⚠️ Vakolat ULANISH paytida tekshiriladi, socket esa soatlab ochiq
   * turadi. Busiz faolsizlantirilgan xodim, boshqa tumanga o'tkazilgan
   * mas'ul yoki muddati o'tgan token egasi brauzer yopilguncha XAVF
   * larni tinglayverardi. Endi xonalar BAZADAGI joriy holatga moslanadi:
   * vakolat qolmasa — XAVF xonalaridan chiqariladi va `auth:expired`
   * yuboriladi (mijoz yangi token bilan qayta ulanadi).
   */
  private async revalidate(): Promise<void> {
    if (!this.server) return;
    const sockets = (await this.server.fetchSockets()).filter(
      (socket) => (socket.data as { auth?: SocketAuth } | undefined)?.auth,
    );
    if (sockets.length === 0) return;

    const auths = sockets.map(
      (socket) => (socket.data as { auth: SocketAuth }).auth,
    );
    const users = await this.users.find({
      where: { id: In([...new Set(auths.map((auth) => auth.userId))]) },
      select: {
        id: true,
        role: true,
        districtId: true,
        agencyId: true,
        isActive: true,
      },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    const now = Date.now();

    sockets.forEach((socket, index) => {
      const auth = auths[index];
      const user = byId.get(auth.userId);
      const valid = !!user?.isActive && auth.expiresAt > now;
      const desired = valid && user ? this.privilegedRooms(user) : [];
      for (const room of socket.rooms) {
        const privileged =
          room.startsWith('incidents:') || room.startsWith('user:');
        if (privileged && !desired.includes(room)) socket.leave(room);
      }
      const missing = desired.filter((room) => !socket.rooms.has(room));
      if (missing.length > 0) socket.join(missing);
      if (!valid) {
        (socket.data as { auth?: SocketAuth }).auth = undefined;
        socket.emit('auth:expired', {
          message: 'Sessiya tugadi yoki vakolat o‘zgardi — qayta ulaning',
        });
      }
    });
  }

  emitBoilerStatus(event: BoilerStatusEvent): void {
    /*
     * ⚠️ `server` bo'sh bo'lishi mumkin: gateway hali ko'tarilmagan
     * paytda (startup, migratsiya) telemetriya kelsa, `undefined.emit`
     * butun ingest'ni yiqitardi — ya'ni jonli yangilanish yo'qligi
     * uchun MA'LUMOT YO'QOLARDI.
     */
    if (!this.server) return;
    this.server.to('region').emit('boiler:status', event);
    this.server.to(`district:${event.districtId}`).emit('boiler:status', event);
  }

  emitAlert(event: AlertEvent): void {
    if (!this.server) return;
    this.server.emit('alert:new', event);
  }
}
