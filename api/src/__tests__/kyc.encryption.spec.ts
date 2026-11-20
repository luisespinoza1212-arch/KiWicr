// Copyright (c) 2026 Francisco Javier Campos Diaz. Todos los derechos reservados.
import { Test, TestingModule } from '@nestjs/testing';
import { KYCService } from '../kyc/kyc.service';
import { DiditProvider } from '../kyc/didit.provider';
import { PrismaService } from '../prisma/prisma.service';
import { FieldCipher } from '../security/field-cipher';
import { KycDocumentStorage } from '../kyc/kyc-document-storage.service';

// Referencias válidas del bucket privado (formato <userId>/<tipo>/<uuid>.webp).
const UUID = '0b6f3c1e-9a2d-4c5e-8f7a-1234567890ab';
const ref = (userId: string, type: string) => `kyc://${userId}/${type}/${UUID}.webp`;

describe('KYCService — cifrado de números de identidad en reposo', () => {
  let service: KYCService;
  let prisma: any;
  let cipher: FieldCipher;
  let documents: any;

  beforeEach(async () => {
    process.env.KYC_FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');

    prisma = {
      kYCVerification: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    documents = {
      isConfigured: jest.fn().mockReturnValue(true),
      signedUrl: jest.fn(async (r: string) => `https://signed.example/${r.slice(6)}?token=t`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KYCService,
        DiditProvider,
        { provide: PrismaService, useValue: prisma },
        FieldCipher,
        { provide: KycDocumentStorage, useValue: documents },
      ],
    }).compile();

    service = module.get<KYCService>(KYCService);
    cipher = module.get<FieldCipher>(FieldCipher);
    prisma.$transaction = jest.fn();
  });

  it('submitDocuments guarda idNumber cifrado, nunca en claro', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue(null);
    prisma.kYCVerification.create.mockImplementation(async ({ data }) => data);

    await service.submitDocuments('u-1', {
      idNumber: '209880065',
      idType: 'cedula',
      idFrontUrl: ref('u-1', 'idFront'),
      selfieUrl: ref('u-1', 'selfie'),
      licenseUrl: ref('u-1', 'license'),
    });

    const stored = prisma.kYCVerification.create.mock.calls[0][0].data;
    expect(stored.status).toBe('documents_submitted');
    expect(stored.idFrontUrl).toBe(ref('u-1', 'idFront'));
    expect(stored.idNumber).toMatch(/^v1:/);
    expect(stored.idNumber).not.toContain('209880065');
    expect(stored.idType).toBe('cedula'); // campo no sensible queda intacto
  });

  it('rechaza envíos sin documentos (nunca crea una revisión vacía)', async () => {
    await expect(
      service.submitDocuments('u-1', { idNumber: '209880065', idType: 'cedula' }),
    ).rejects.toThrow('Faltan las fotos');
    expect(prisma.kYCVerification.create).not.toHaveBeenCalled();
  });

  it('rechaza URLs externas (aunque sean https): solo refs kyc:// del bucket privado', async () => {
    await expect(
      service.submitDocuments('u-1', {
        idFrontUrl: 'javascript:alert(1)',
        selfieUrl: 'https://cdn.example.com/selfie.jpg',
        licenseUrl: ref('u-1', 'license'),
      }),
    ).rejects.toThrow('Faltan las fotos');
    expect(prisma.kYCVerification.create).not.toHaveBeenCalled();
  });

  it('rechaza documentos de OTRO usuario (no se pueden adjuntar fotos ajenas)', async () => {
    await expect(
      service.submitDocuments('u-1', {
        idFrontUrl: ref('u-2', 'idFront'),
        selfieUrl: ref('u-1', 'selfie'),
        licenseUrl: ref('u-1', 'license'),
      }),
    ).rejects.toThrow('Faltan las fotos');
    expect(prisma.kYCVerification.create).not.toHaveBeenCalled();
  });

  it('rechaza refs con path manipulado (../, tipo inventado)', async () => {
    await expect(
      service.submitDocuments('u-1', {
        idFrontUrl: `kyc://u-1/../u-2/idFront/${UUID}.webp`,
        selfieUrl: `kyc://u-1/passport/${UUID}.webp`,
        licenseUrl: ref('u-1', 'license'),
      }),
    ).rejects.toThrow('Faltan las fotos');
  });

  it('exige la foto de la licencia', async () => {
    await expect(
      service.submitDocuments('u-1', {
        idFrontUrl: ref('u-1', 'idFront'),
        selfieUrl: ref('u-1', 'selfie'),
      }),
    ).rejects.toThrow('licencia');
  });

  it('documentos opcionales inválidos se descartan sin bloquear el envío', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue(null);
    prisma.kYCVerification.create.mockImplementation(async ({ data }) => data);

    await service.submitDocuments('u-1', {
      idFrontUrl: ref('u-1', 'idFront'),
      selfieUrl: ref('u-1', 'selfie'),
      licenseUrl: ref('u-1', 'license'),
      insuranceUrl: 'https://evil.example.com/x.png',
    });

    const stored = prisma.kYCVerification.create.mock.calls[0][0].data;
    expect(stored.insuranceUrl).toBeUndefined();
  });

  it('reenvío tras rechazo vuelve a documents_submitted y limpia el motivo', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue({ id: 'v-1', status: 'rejected' });
    prisma.kYCVerification.update.mockImplementation(async ({ data }) => data);

    await service.submitDocuments('u-1', {
      idFrontUrl: ref('u-1', 'idFront'),
      selfieUrl: ref('u-1', 'selfie'),
      licenseUrl: ref('u-1', 'license'),
    });

    const data = prisma.kYCVerification.update.mock.calls[0][0].data;
    expect(data.status).toBe('documents_submitted');
    expect(data.rejectionReason).toBeNull();
  });

  it('getVerificationByUserId (dueño) recibe el número enmascarado por defecto', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue({
      idNumber: cipher.encrypt('209880065'),
    });

    const row = await service.getVerificationByUserId('u-1');
    expect(row.idNumber).toBe('••••0065');
  });

  it('detalle de revisión admin recibe el número completo', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue({
      idNumber: cipher.encrypt('209880065'),
    });

    const row = await service.getVerificationById('v-1');
    expect(row.idNumber).toBe('209880065');
  });

  it('detalle admin cambia cada ref por un link firmado temporal', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue({
      id: 'v-1',
      idFrontUrl: ref('u-1', 'idFront'),
      selfieUrl: ref('u-1', 'selfie'),
      licenseUrl: null,
    });

    const row = await service.getVerificationById('v-1');
    expect(row.idFrontUrl).toBe(`https://signed.example/u-1/idFront/${UUID}.webp?token=t`);
    expect(row.selfieUrl).toContain('/u-1/selfie/');
    expect(row.licenseUrl).toBeNull();
    expect(documents.signedUrl).toHaveBeenCalledTimes(2);
  });

  it('listas admin NO firman (las fotos solo se piden al abrir el detalle)', async () => {
    prisma.kYCVerification.findMany.mockResolvedValue([{ idFrontUrl: ref('u-1', 'idFront') }]);
    await service.getAllVerifications();
    expect(documents.signedUrl).not.toHaveBeenCalled();
  });

  describe('aprobar / rechazar', () => {
    let tx: any;
    beforeEach(() => {
      tx = {
        kYCVerification: { update: jest.fn(async ({ data }) => ({ id: 'v-1', ...data })) },
        driverProfile: { update: jest.fn() },
        merchantProfile: { update: jest.fn() },
        notification: { create: jest.fn() },
      };
      prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
    });

    it('aprobar marca el perfil del repartidor como approved y le avisa', async () => {
      prisma.kYCVerification.findUnique.mockResolvedValue({
        id: 'v-1',
        userId: 'u-1',
        status: 'documents_submitted',
        user: { role: 'driver' },
      });

      const out = await service.approveVerification('v-1', 'admin-1');

      expect(out.status).toBe('approved');
      expect(tx.kYCVerification.update.mock.calls[0][0].data.verifiedBy).toBe('admin-1');
      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: 'u-1' },
        data: expect.objectContaining({ kycStatus: 'approved' }),
      });
      expect(tx.notification.create.mock.calls[0][0].data.type).toBe('kyc_approved');
    });

    it('rechazar guarda el motivo, marca el perfil y avisa con el motivo', async () => {
      prisma.kYCVerification.findUnique.mockResolvedValue({
        id: 'v-1',
        userId: 'u-1',
        status: 'documents_submitted',
        user: { role: 'driver' },
      });

      await service.rejectVerification('v-1', 'admin-1', 'Foto borrosa');

      expect(tx.kYCVerification.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ status: 'rejected', rejectionReason: 'Foto borrosa' }),
      );
      expect(tx.driverProfile.update).toHaveBeenCalledWith({
        where: { userId: 'u-1' },
        data: { kycStatus: 'rejected' },
      });
      const notif = tx.notification.create.mock.calls[0][0].data;
      expect(notif.type).toBe('kyc_rejected');
      expect(notif.body).toContain('Foto borrosa');
    });

    it('no se puede aprobar dos veces', async () => {
      prisma.kYCVerification.findUnique.mockResolvedValue({
        id: 'v-1',
        status: 'approved',
        user: { role: 'driver' },
      });
      await expect(service.approveVerification('v-1', 'admin-1')).rejects.toThrow(
        'ya está aprobada',
      );
    });
  });

  it('getVerificationByUserId por defecto enmascara (solo últimos 4)', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue({
      idNumber: cipher.encrypt('209880065'),
    });

    const row = await service.getVerificationByUserId('u-1', { maskIdentity: true });
    expect(row.idNumber).toBe('••••0065');
  });

  it('filas legacy en texto plano se enmascaran al leer y nunca se devuelven en claro', async () => {
    prisma.kYCVerification.findUnique.mockResolvedValue({ idNumber: '209880065' });

    const row = await service.getVerificationByUserId('u-1');
    expect(row.idNumber).toBe('••••0065');
  });

  it('listas admin devuelven el valor enmascarado', async () => {
    prisma.kYCVerification.findMany.mockResolvedValue([{ idNumber: cipher.encrypt('1234567890') }]);

    const rows = await service.getAllVerifications();
    expect(rows[0].idNumber).toBe('••••7890');
  });

  it('listas admin incluyen la relación user (regresión: el panel admin leía kyc.user.role)', async () => {
    prisma.kYCVerification.findMany.mockResolvedValue([
      {
        id: 'v-1',
        status: 'pending',
        user: { id: 'u-1', email: 'a@b.c', phone: '8888', role: 'driver' },
      },
    ]);

    const rows = await service.getAllVerifications();
    expect(prisma.kYCVerification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { user: expect.objectContaining({ select: expect.anything() }) },
      }),
    );
    expect(rows[0].user.role).toBe('driver');
  });

  it('production sin KYC_FIELD_ENCRYPTION_KEY no arranca', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.KYC_FIELD_ENCRYPTION_KEY;

    expect(() => new FieldCipher()).toThrow('KYC_FIELD_ENCRYPTION_KEY');
    process.env.NODE_ENV = 'test';
  });
});
