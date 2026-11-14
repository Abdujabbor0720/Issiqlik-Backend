import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { District } from '../entities/district.entity';
import { Region } from '../entities/region.entity';
import { User } from '../entities/user.entity';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [TypeOrmModule.forFeature([Region, District, User])],
  providers: [BootstrapService],
})
export class BootstrapModule {}
