import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Excel import — qaysi tumanga (fayl o'zi tumanni aniq aytmaydi). */
export class BoilerImportDto {
  @ApiProperty({ description: 'Tuman / shahar', format: 'uuid' })
  @IsUUID('4', { message: 'Tuman tanlanmagan' })
  districtId!: string;
}
