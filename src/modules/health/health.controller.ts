import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Tizim holati')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * ⚠️ Baza HAQIQATAN so'rov bilan tekshiriladi (`SELECT 1`), ulanish
   * obyekti borligi bilan emas. TypeORM ulanish hovuzi «ulangan» deb
   * turgani holda baza qayta ishga tushgan bo'lishi mumkin va
   * monitoring buni sezmay qolardi.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Server va baza holati' })
  async check() {
    const startedAt = Date.now();
    let database: 'ok' | 'down' = 'ok';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'down';
    }

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      latencyMs: Date.now() - startedAt,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
