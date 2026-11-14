import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { Boiler } from '../../database/entities/boiler.entity';
import { BOILER_STATUS_LABELS } from '../../helpers/boiler-status.helper';
import { formatDateTimeUz } from '../../helpers/date.helpers';
import { applyDistrictScope } from '../../helpers/scope.helper';
import type { BoilerQueryDto } from './dto/boiler.dto';

/**
 * EXCEL EKSPORTI.
 *
 * ⚠️ `ro'yxat` servisidan FOYDALANMAYDI: u sahifalangan (200 tagacha),
 * eksport esa HAMMASINI olishi kerak. Sahifalashni aylanib o'tish uchun
 * `limit: 100000` yuborish esa `PaginationDto` validatsiyasini
 * buzardi — shuning uchun bu yerda alohida, sahifasiz so'rov.
 *
 * ⚠️ `stream` ishlatiladi: 5000 qatorli kitob xotirada yig'ilsa, bir
 * necha parallel eksport serverni xotira bo'yicha yiqitardi.
 */
@Injectable()
export class BoilersExportService {
  constructor(
    @InjectRepository(Boiler) private readonly repo: Repository<Boiler>,
  ) {}

  async toExcel(
    query: BoilerQueryDto,
    user: AuthUser,
    res: Response,
  ): Promise<void> {
    const qb = this.repo
      .createQueryBuilder('boiler')
      .leftJoin('boiler.district', 'district')
      .addSelect(['district.name'])
      .leftJoin('boiler.firm', 'firm')
      .addSelect(['firm.name'])
      .leftJoin('boiler.organization', 'organization')
      .addSelect(['organization.name'])
      .leftJoin('boiler.brand', 'brand')
      .addSelect(['brand.name'])
      .orderBy('district.name', 'ASC')
      .addOrderBy('boiler.lotNumber', 'ASC');

    applyDistrictScope(qb, user, 'boiler.district_id');
    if (!query.includeArchived) qb.andWhere('boiler.is_archived = false');
    if (query.districtIds?.length) {
      qb.andWhere('boiler.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      });
    }
    if (query.statuses?.length) {
      qb.andWhere('boiler.current_status IN (:...statuses)', {
        statuses: query.statuses,
      });
    }

    const rows = await qb.getMany();

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="kotyollar-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const sheet = workbook.addWorksheet('Kotyollar');

    sheet.columns = [
      { header: '№', key: 'index', width: 6 },
      { header: 'Tuman / shahar', key: 'district', width: 22 },
      { header: 'Lot raqami', key: 'lot', width: 18 },
      { header: 'DXSH firma nomi', key: 'firm', width: 28 },
      { header: 'Tashkilot nomi', key: 'organization', width: 32 },
      { header: 'Kotyol markasi', key: 'brand', width: 18 },
      { header: 'Kotyol soni', key: 'count', width: 12 },
      { header: '60 gradusda norma', key: 'norm', width: 18 },
      { header: 'Holati', key: 'status', width: 20 },
      { header: 'Oxirgi harorat, °C', key: 'temp', width: 18 },
      { header: 'Oxirgi signal', key: 'lastSeen', width: 24 },
      { header: 'Manzil', key: 'address', width: 34 },
      { header: 'Mas‘ul', key: 'responsible', width: 22 },
      { header: 'Telefon', key: 'phone', width: 16 },
    ];

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF123E66' },
    };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    header.height = 24;
    header.commit();

    rows.forEach((boiler, index) => {
      sheet
        .addRow({
          index: index + 1,
          district: boiler.district?.name ?? '—',
          lot: boiler.lotNumber,
          firm: boiler.firm?.name ?? '—',
          organization: boiler.organization?.name ?? '—',
          brand: boiler.brand?.name ?? '—',
          count: boiler.boilerCount,
          norm: boiler.normAt60 ?? '—',
          status: BOILER_STATUS_LABELS[boiler.currentStatus],
          temp: boiler.lastTemperature ?? '—',
          lastSeen: formatDateTimeUz(boiler.lastReadingAt),
          address: boiler.address ?? '—',
          responsible: boiler.responsibleName ?? '—',
          phone: boiler.responsiblePhone ?? '—',
        })
        .commit();
    });

    sheet.commit();
    await workbook.commit();
  }
}
