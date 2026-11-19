import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { Mahalla, ObjectType } from '../../database/entities/catalog.entities';
import { District } from '../../database/entities/district.entity';
import { Region } from '../../database/entities/region.entity';
import { DistrictDirectoryService } from './district-directory.service';
import { ObjectTypeDirectoryService } from './object-type-directory.service';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Region, District, Boiler, ObjectType, Mahalla]),
  ],
  controllers: [GeoController],
  providers: [GeoService, DistrictDirectoryService, ObjectTypeDirectoryService],
  // ⚠️ `DistrictDirectoryService` — telemetriya (plata tumani) uchun.
  exports: [GeoService, DistrictDirectoryService, ObjectTypeDirectoryService],
})
export class GeoModule {}
