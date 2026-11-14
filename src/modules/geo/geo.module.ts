import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { District } from '../../database/entities/district.entity';
import { Region } from '../../database/entities/region.entity';
import { DistrictDirectoryService } from './district-directory.service';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

@Module({
  imports: [TypeOrmModule.forFeature([Region, District, Boiler])],
  controllers: [GeoController],
  providers: [GeoService, DistrictDirectoryService],
  // ⚠️ `DistrictDirectoryService` — telemetriya (plata tumani) uchun.
  exports: [GeoService, DistrictDirectoryService],
})
export class GeoModule {}
