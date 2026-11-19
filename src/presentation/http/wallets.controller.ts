import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { CreateWallet } from '../../application/create-wallet/create-wallet.use-case';
import { parseCreateWallet } from './request-parsers';

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CreateWallet) private readonly createWallet: CreateWallet) { }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.createWallet.execute(parseCreateWallet(body));
  }
}
