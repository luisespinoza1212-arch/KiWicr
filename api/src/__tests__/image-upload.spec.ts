// Copyright (c) 2026 Francisco Javier Campos Diaz. Todos los derechos reservados.
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp = require('sharp');
import heicConvert = require('heic-convert');
import { ImageUploadService } from '../menu/image-upload.service';

// heic-convert real necesita un HEIC real; se simula y se verifica que se use.
jest.mock('heic-convert', () => jest.fn());

/**
 * Subida de imágenes SIN red: validación (configuración, magic bytes,
 * tamaño), normalización real con sharp (512×512 webp) y subida a Supabase
 * Storage simulada con un spy sobre `store`.
 */
describe('ImageUploadService', () => {
  const CONFIGURED = {
    SUPABASE_URL: 'https://demo.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  };

  const build = async (env: Record<string, string | undefined> = CONFIGURED) => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImageUploadService,
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    return moduleRef.get(ImageUploadService);
  };

  const realPng = (w = 800, h = 600) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#7cc142' } })
      .png()
      .toBuffer();

  const mockStore = (svc: ImageUploadService, impl?: (path: string, body: Buffer) => any) =>
    jest
      .spyOn(svc as any, 'store')
      .mockImplementation(
        (impl ??
          ((path: string) =>
            Promise.resolve(
              `https://demo.supabase.co/storage/v1/object/public/kiwi/${path}`,
            ))) as any,
      );

  afterEach(() => jest.restoreAllMocks());

  it('sin SUPABASE_URL/KEY responde 503 y reporta isConfigured=false', async () => {
    const svc = await build({});
    expect(svc.isConfigured()).toBe(false);
    await expect(
      svc.uploadProductImage({ buffer: Buffer.from('x'), size: 1 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('URL sin https no cuenta como configurado', async () => {
    const svc = await build({ ...CONFIGURED, SUPABASE_URL: 'demo.supabase.co' });
    expect(svc.isConfigured()).toBe(false);
  });

  it('configurado + archivo vacío → 400', async () => {
    const svc = await build();
    await expect(
      svc.uploadProductImage({ buffer: Buffer.alloc(0), size: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('configurado + magic bytes inválidos → 400 (no confía en filename)', async () => {
    const svc = await build();
    const fake = Buffer.concat([Buffer.from('<?php echo "shell"; ?>'), Buffer.alloc(1024, 0x41)]);
    await expect(
      svc.uploadProductImage({ buffer: fake, size: fake.length, originalname: 'foto.jpg' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('configurado + >5MB → 413', async () => {
    const svc = await build();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);
    await expect(svc.uploadProductImage({ buffer: big, size: big.length })).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('magic bytes de PNG pero contenido dañado → 400 y no llega a Supabase', async () => {
    const svc = await build();
    const store = mockStore(svc);
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2048, 0x00),
    ]);
    await expect(
      svc.uploadProductImage({ buffer: broken, size: broken.length }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store).not.toHaveBeenCalled();
  });

  it('PNG real → sube un webp 512×512 a la carpeta correcta y devuelve la URL pública', async () => {
    const svc = await build();
    const store = mockStore(svc);
    const png = await realPng();

    const { url } = await svc.uploadProductImage({ buffer: png, size: png.length });

    expect(store).toHaveBeenCalledTimes(1);
    const [path, body] = store.mock.calls[0] as [string, Buffer];
    expect(path).toMatch(/^kiwi\/products\/[0-9a-f-]{36}\.webp$/);
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
    expect(url).toBe(`https://demo.supabase.co/storage/v1/object/public/kiwi/${path}`);
  });

  it('cada tipo de subida usa su carpeta', async () => {
    const svc = await build();
    const store = mockStore(svc);
    const png = await realPng(64, 64);
    const file = { buffer: png, size: png.length };

    await svc.uploadProofImage(file);
    await svc.uploadDriverPhoto(file);
    await svc.uploadCustomerAvatar(file);
    await svc.uploadMerchantLogo(file);

    const folders = store.mock.calls.map(([p]) => String(p).split('/').slice(0, 2).join('/'));
    expect(folders).toEqual(['kiwi/proofs', 'kiwi/drivers', 'kiwi/customers', 'kiwi/merchants']);
  });

  it('acepta HEIC (Samsung/iPhone): lo convierte con heic-convert y sube webp', async () => {
    const svc = await build();
    const store = mockStore(svc);
    const jpeg = await sharp({
      create: { width: 300, height: 400, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    (heicConvert as unknown as jest.Mock).mockResolvedValue(jpeg);
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic', 'ascii'),
      Buffer.alloc(2048, 0x00),
    ]);

    await svc.uploadProductImage({ buffer: heic, size: heic.length, originalname: 'foto.heic' });

    expect(heicConvert).toHaveBeenCalledWith(expect.objectContaining({ format: 'JPEG' }));
    const body = store.mock.calls[0][1] as Buffer;
    expect((await sharp(body).metadata()).format).toBe('webp');
  });

  it('si Supabase falla → 503 (no 500 críptico)', async () => {
    const svc = await build();
    mockStore(svc, () => Promise.reject(new Error('network disabled in test')));
    const png = await realPng(64, 64);
    await expect(svc.uploadProductImage({ buffer: png, size: png.length })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
