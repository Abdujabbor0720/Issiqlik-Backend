import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemSetting } from '../../database/entities/system-setting.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * ⚠️ `@Global()`: chegaralar telemetriya, dashboard, ogohlantirish va
 * cron'larda kerak. Har modulga alohida import qilinsa, yangi modul
 * yozgan dasturchi uni unutib, chegaralarni QOTIRIB yozib qo'yardi.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting])],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
