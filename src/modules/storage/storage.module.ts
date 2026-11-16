import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** ⚠️ Global: fayl arxivi bir nechta modulda kerak bo'ladi (import, keyin hisobotlar). */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
