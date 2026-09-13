import {
  Controller,
  Post,
  HttpCode,
  Param,
  HttpStatus,
  Res,
  ParseIntPipe,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('dev-login/:accountNumber')
  @HttpCode(HttpStatus.OK)
  devLogin(
    @Param('accountNumber', ParseIntPipe) accountNumber: number,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.usersService.devLogin(accountNumber, response as any);
  }
}
