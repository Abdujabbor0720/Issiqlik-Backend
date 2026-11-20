import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Boiler } from '../../database/entities/boiler.entity';
import { Organization } from '../../database/entities/catalog.entities';
import { District } from '../../database/entities/district.entity';
import {
  ResponsibleAssignment,
  ResponsiblePerson,
} from '../../database/entities/responsible.entities';
import { User } from '../../database/entities/user.entity';
import { AccessModule } from '../access/access.module';
import { ResponsiblesController } from './responsibles.controller';
import { ResponsiblesService } from './responsibles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ResponsiblePerson,
      ResponsibleAssignment,
      Boiler,
      Organization,
      District,
      User,
    ]),
    AccessModule,
  ],
  controllers: [ResponsiblesController],
  providers: [ResponsiblesService],
  // ⚠️ XAVF dvigateli javobgarlarni shu servisdan muhrlaydi.
  exports: [ResponsiblesService],
})
export class ResponsiblesModule {}
