import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

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
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    /*
     * ⚠️ Mijoz TUMAN XONASIGA qo'shiladi (`district:<id>`). Tuman
     * operatori butun viloyat hodisalarini olmasligi kerak: bu ham
     * ortiqcha tarmoq, ham uning ko'rishi shart bo'lmagan ma'lumot.
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
