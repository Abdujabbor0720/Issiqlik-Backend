import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  CurrentUser,
  type AuthUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService, type LoginResult } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './dto/auth.dto';

@ApiTags('Autentifikatsiya')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  /**
   * ⚠️ Login uchun ALOHIDA, qattiq limit: umumiy limit (daqiqasiga 300)
   * parol tanlash uchun yetarlicha keng. Bu yerda esa daqiqasiga 10 ta
   * urinish — odam uchun yetarli, avtomat tanlash uchun yo'q.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tizimga kirish' })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResult> {
    return this.service.login(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Access tokenni yangilash' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<LoginResult> {
    return this.service.refresh(dto.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @ApiBearerAuth('bearer')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Tizimdan chiqish' })
  async logout(
    @Body() dto: RefreshDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.service.logout(dto.refreshToken, user);
  }

  @ApiBearerAuth('bearer')
  @Get('me')
  @ApiOperation({ summary: 'Joriy foydalanuvchi' })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @ApiBearerAuth('bearer')
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Parolni o‘zgartirish' })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.service.changePassword(user, dto);
  }
}
