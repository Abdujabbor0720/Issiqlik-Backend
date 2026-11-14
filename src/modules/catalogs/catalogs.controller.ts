import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CatalogsService, type CatalogKind } from './catalogs.service';
import {
  CatalogQueryDto,
  CreateCatalogItemDto,
  UpdateCatalogItemDto,
} from './dto/catalog.dto';

const KINDS: CatalogKind[] = [
  'brands',
  'firms',
  'organizations',
  'object-types',
];

/**
 * ⚠️ Uchala katalog BITTA kontroller orqali: `/catalogs/brands`,
 * `/catalogs/firms`, `/catalogs/organizations`. Shakli bir xil bo'lgani
 * uchun uchta nusxa yozish faqat birinchi tuzatishda ajralib ketadigan
 * uch xil xulq-atvorga olib kelardi.
 */
@ApiTags('Kataloglar')
@ApiBearerAuth('bearer')
@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly service: CatalogsService) {}

  @Get(':kind')
  @RequirePermissions(PERMISSIONS.CATALOGS_VIEW)
  @ApiParam({ name: 'kind', enum: KINDS })
  @ApiOperation({ summary: 'Katalog ro‘yxati' })
  list(@Param('kind') kind: string, @Query() query: CatalogQueryDto) {
    return this.service.list(this.assertKind(kind), query);
  }

  @Post(':kind')
  @RequirePermissions(PERMISSIONS.CATALOGS_MANAGE)
  @ApiParam({ name: 'kind', enum: KINDS })
  create(
    @Param('kind') kind: string,
    @Body() dto: CreateCatalogItemDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.create(this.assertKind(kind), dto, actor);
  }

  @Patch(':kind/:id')
  @RequirePermissions(PERMISSIONS.CATALOGS_MANAGE)
  @ApiParam({ name: 'kind', enum: KINDS })
  update(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() dto: UpdateCatalogItemDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.update(this.assertKind(kind), id, dto, actor);
  }

  @Delete(':kind/:id')
  @RequirePermissions(PERMISSIONS.CATALOGS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'kind', enum: KINDS })
  remove(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.remove(this.assertKind(kind), id, actor);
  }

  /** ⚠️ URL bo'lagi TEKSHIRILADI: aks holda u to'g'ridan-to'g'ri
   *  `this.meta[kind]` kaliti bo'lib, `undefined` bilan yiqilardi. */
  private assertKind(kind: string): CatalogKind {
    if (!KINDS.includes(kind as CatalogKind)) {
      throw new BadRequestException(
        `Noma'lum katalog: ${kind}. Mavjudlari: ${KINDS.join(', ')}`,
      );
    }
    return kind as CatalogKind;
  }
}
