import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { District } from '../../database/entities/district.entity';
import { BoilersController } from './boilers.controller';
import { BoilersExportService } from './boilers-export.service';
import { BoilersService } from './boilers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Boiler, District])],
  controllers: [BoilersController],
  providers: [BoilersService, BoilersExportService],
  exports: [BoilersService],
})
export class BoilersModule {}
