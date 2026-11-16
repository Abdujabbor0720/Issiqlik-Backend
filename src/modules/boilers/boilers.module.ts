import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { District } from '../../database/entities/district.entity';
import { BoilersController } from './boilers.controller';
import { BoilersExportService } from './boilers-export.service';
import { BoilersService } from './boilers.service';
import { BoilerImportController } from './import/boiler-import.controller';
import { BoilerImportService } from './import/boiler-import.service';

@Module({
  imports: [TypeOrmModule.forFeature([Boiler, District])],
  controllers: [BoilersController, BoilerImportController],
  providers: [BoilersService, BoilersExportService, BoilerImportService],
  exports: [BoilersService],
})
export class BoilersModule {}
