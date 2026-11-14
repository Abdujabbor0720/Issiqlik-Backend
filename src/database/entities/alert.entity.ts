import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import {
  AlertSeverity,
  AlertState,
  AlertType,
} from '../../common/constants/enums';
import { BaseEntity } from './base.entity';
import { Boiler } from './boiler.entity';
import { User } from './user.entity';
import { numericTransformer } from './column-transformers';

/**
 * OGOHLANTIRISH — «shu kotyolda muammo bor».
 *
 * ⚠️ HAR O'LCHOVDA YOZILMAYDI. Bitta kotyol sovib qolsa va har 30
 * soniyada signal kelsa, kuniga 2880 ta bir xil ogohlantirish paydo
 * bo'lardi va ro'yxat o'qilmas holga kelardi. Buning o'rniga bitta
 * OCHIQ qator yuritiladi: holat davom etsa `lastSeenAt` yangilanadi,
 * holat tiklansa qator YOPILADI (`resolvedAt`). Shu tufayli ekranda
 * «hozir nechta muammo bor» degan savolga aniq javob bor.
 */
@Entity('alerts')
@Index('IDX_alerts_state_created', ['state', 'createdAt'])
export class Alert extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', name: 'boiler_id' })
  boilerId!: string;

  @ManyToOne(() => Boiler, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'boiler_id' })
  boiler!: Boiler;

  @Column({ type: 'enum', enum: AlertType })
  type!: AlertType;

  @Column({ type: 'enum', enum: AlertSeverity, default: AlertSeverity.WARNING })
  severity!: AlertSeverity;

  @Index()
  @Column({ type: 'enum', enum: AlertState, default: AlertState.OPEN })
  state!: AlertState;

  @Column({ type: 'varchar', length: 400 })
  message!: string;

  /** Muammo boshlangan paytdagi harorat — «qanchada edi» degan savolga javob. */
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  temperature!: number | null;

  /** Muammo DAVOM etayotgani oxirgi marta qachon tasdiqlangan. */
  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt!: Date;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'acknowledged_at', nullable: true })
  acknowledgedAt!: Date | null;

  @Column({ type: 'uuid', name: 'acknowledged_by_id', nullable: true })
  acknowledgedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'acknowledged_by_id' })
  acknowledgedBy!: User | null;

  @Column({ type: 'varchar', length: 500, name: 'ack_note', nullable: true })
  ackNote!: string | null;
}
