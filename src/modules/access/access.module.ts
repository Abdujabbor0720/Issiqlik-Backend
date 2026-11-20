import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { ResponsiblePerson } from '../../database/entities/responsible.entities';
import { GeoModule } from '../geo/geo.module';
import { ObjectAccessService } from './object-access.service';

/** Vakolat chegarasi — XAVF, javobgarlar reyestri va monitoring jadvali uchun. */
@Module({
  imports: [TypeOrmModule.forFeature([Boiler, ResponsiblePerson]), GeoModule],
  providers: [ObjectAccessService],
  exports: [ObjectAccessService],
})
export class AccessModule {}
