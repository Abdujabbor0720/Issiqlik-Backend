import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import {
  RoomHistoryQueryDto,
  RoomSummaryQueryDto,
  UpdateRoomDto,
} from './dto/room.dto';
import { RoomsService } from './rooms.service';

/**
 * XONALAR.
 *
 * ⚠️ Alohida ruxsat kaliti YO'Q — kotyolniki ishlatiladi: xona binoning
 * bir qismi va uni ko'rish/nomlash kotyolni ko'rish/tahrirlash bilan
 * bir xil qaror. Alohida kalit qo'shilsa, u backend
 * (`permissions.ts`) va frontend ro'yxatida qo'lda sinxron turishi
 * kerak bo'lardi va bir kuni tuman mas'uli o'z binosining xonalarini
 * ko'ra olmay qolardi.
 *
 * ⚠️ Tuman chegarasi SERVISDA (`assertBoilerVisible`,
 * `assertDistrictAccess`) — har yo'lda.
 */
@ApiTags('Xonalar (havo harorati)')
@ApiBearerAuth('bearer')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly service: RoomsService) {}

  /*
   * ⚠️ `summary` va `by-boiler` yo'llari `:id` DAN OLDIN — Express
   * yo'llarni e'lon tartibida solishtiradi.
   */

  @Get('summary')
  @RequirePermissions(PERMISSIONS.BOILERS_VIEW)
  @ApiOperation({ summary: 'Viloyat/tuman bo‘yicha xonalar holati' })
  summary(@Query() query: RoomSummaryQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.summary(
      user,
      query.districtId ? [query.districtId] : undefined,
    );
  }

  @Get('by-boiler/:boilerId')
  @RequirePermissions(PERMISSIONS.BOILERS_VIEW)
  @ApiOperation({ summary: 'Kotyol (bino) xonalari — joriy harorat bilan' })
  listForBoiler(
    @Param('boilerId', new ParseUUIDPipe({ version: '4' })) boilerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.listForBoiler(boilerId, user);
  }

  @Get('by-boiler/:boilerId/history')
  @RequirePermissions(PERMISSIONS.BOILERS_VIEW)
  @ApiOperation({ summary: 'Xonalar harorati tarixi (grafik)' })
  history(
    @Param('boilerId', new ParseUUIDPipe({ version: '4' })) boilerId: string,
    @Query() query: RoomHistoryQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.history(boilerId, query.hours ?? 24, user);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.BOILERS_UPDATE)
  @ApiOperation({ summary: 'Xonani nomlash / nazoratga olish' })
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateRoomDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(params.id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.BOILERS_UPDATE)
  @ApiOperation({ summary: 'Xonani o‘chirish (tarixi bilan)' })
  remove(@Param() params: IdParamDto, @CurrentUser() user: AuthUser) {
    return this.service.remove(params.id, user);
  }
}
