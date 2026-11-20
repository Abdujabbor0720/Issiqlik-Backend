import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import {
  Agency,
  BoilerBrand,
  Firm,
  Mahalla,
  ObjectType,
  Organization,
} from '../../database/entities/catalog.entities';
import { GeoModule } from '../geo/geo.module';
import { CatalogsController } from './catalogs.controller';
import { CatalogsService } from './catalogs.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BoilerBrand,
      Firm,
      Organization,
      ObjectType,
      Mahalla,
      Agency,
      Boiler,
    ]),
    GeoModule,
  ],
  controllers: [CatalogsController],
  providers: [CatalogsService],
  exports: [CatalogsService],
})
export class CatalogsModule {}
