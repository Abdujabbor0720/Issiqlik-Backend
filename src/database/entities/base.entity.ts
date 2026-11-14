import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Hamma jadval uchun umumiy ustunlar.
 *
 * ⚠️ Kalit — UUID, `serial` EMAS. Sabab: qurilmalar va eksport fayllari
 * identifikatorni tashqariga olib chiqadi, ketma-ket son esa yozuvlar
 * SONINI va o'sish sur'atini oshkor qiladi. UUID bilan `/boilers/412`
 * kabi havolani qo'lda tanlab ko'rib bo'lmaydi.
 *
 * ⚠️ Vaqt ustunlari `timestamptz`: server Toshkentda, baza esa boshqa
 * mintaqada ko'tarilishi mumkin. `timestamp` (mintaqasiz) bo'lsa, bir
 * kuni ma'lumot besh soatga siljib qolardi.
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
