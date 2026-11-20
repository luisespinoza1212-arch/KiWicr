// Copyright (c) 2026 Francisco Javier Campos Diaz. Todos los derechos reservados.
import { Module } from '@nestjs/common';
import { KYCService } from './kyc.service';
import { KYCController } from './kyc.controller';
import { DiditProvider } from './didit.provider';
import { KycDocumentStorage } from './kyc-document-storage.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FieldCipher } from '../security/field-cipher';

@Module({
  imports: [PrismaModule],
  providers: [KYCService, DiditProvider, FieldCipher, KycDocumentStorage],
  controllers: [KYCController],
  exports: [KYCService],
})
export class KYCModule {}
