import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp = require('sharp');
import { KycDocumentStorage, isOwnKycRef } from '../kyc/kyc-document-storage.service';

/**
 * Documentos KYC al bucket PRIVADO, sin red: el cliente de Supabase se
 * reemplaza por un falso que registra qué se pidió.
 */
describe('KycDocumentStorage', () => {
  const CONFIGURED = {
    SUPABASE_URL: 'https://demo.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  };

  const fakeSupabase = (bucket: { public: boolean } | null) => {
    const calls: any = { upload: [], createBucket: [], signed: [], from: [] };
    const client = {
      storage: {
        getBucket: jest.fn(async () =>
          bucket
            ? { data: bucket, error: null }
            : { data: null, error: { message: 'Bucket not found' } },
        ),
        createBucket: jest.fn(async (name: string, opts: any) => {
          calls.createBucket.push([name, opts]);
          return { data: { name }, error: null };
        }),
        from: jest.fn((name: string) => {
          calls.from.push(name);
          return {
            upload: jest.fn(async (path: string, body: Buffer, opts: any) => {
              calls.upload.push({ path, body, opts });
              return { data: { path }, error: null };
            }),
            createSignedUrl: jest.fn(async (path: string, ttl: number) => {
              calls.signed.push([path, ttl]);
              return {
                data: { signedUrl: `https://demo.supabase.co/sign/${path}?token=x` },
                error: null,
              };
            }),
          };
        }),
      },
    };
    return { client, calls };
  };

  const build = (
    env: Record<string, string> = CONFIGURED,
    bucket: { public: boolean } | null = null,
  ) => {
    const svc = new KycDocumentStorage({ get: (k: string) => env[k] } as unknown as ConfigService);
    const fake = fakeSupabase(bucket);
    if (svc.isConfigured()) (svc as any).client = fake.client;
    return { svc, calls: fake.calls };
  };

  const jpeg = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#3366cc' } })
      .jpeg()
      .toBuffer();

  it('sin Supabase configurado → 503', async () => {
    const { svc } = build({});
    expect(svc.isConfigured()).toBe(false);
    const img = await jpeg(100, 60);
    await expect(
      svc.upload('u-1', 'idFront', { buffer: img, size: img.length }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('tipo de documento inventado → 400', async () => {
    const { svc, calls } = build();
    const img = await jpeg(100, 60);
    await expect(
      svc.upload('u-1', 'passport', { buffer: img, size: img.length }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.upload).toHaveLength(0);
  });

  it('archivo que no es imagen → 400; más de 5 MB → 413', async () => {
    const { svc } = build();
    const fake = Buffer.from('<?php echo 1; ?>'.padEnd(200, 'x'));
    await expect(
      svc.upload('u-1', 'selfie', { buffer: fake, size: fake.length }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);
    await expect(
      svc.upload('u-1', 'selfie', { buffer: big, size: big.length }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('sube al bucket privado kyc-private, en la carpeta del usuario, y devuelve una ref kyc://', async () => {
    const { svc, calls } = build();
    const img = await jpeg(1600, 1000);

    const { ref } = await svc.upload('u-1', 'idFront', { buffer: img, size: img.length });

    expect(calls.createBucket).toEqual([['kyc-private', { public: false }]]);
    expect(calls.from).toContain('kyc-private');
    expect(calls.upload).toHaveLength(1);
    const { path, opts } = calls.upload[0];
    expect(path).toMatch(/^u-1\/idFront\/[0-9a-f-]{36}\.webp$/);
    expect(opts.contentType).toBe('image/webp');
    expect(ref).toBe(`kyc://${path}`);
    expect(isOwnKycRef(ref, 'u-1')).toBe(true);
    expect(isOwnKycRef(ref, 'u-2')).toBe(false);
  });

  it('NO recorta el documento: conserva la proporción y limita el lado mayor a 2000 px', async () => {
    const { svc, calls } = build();
    const img = await jpeg(3000, 1800);

    await svc.upload('u-1', 'license', { buffer: img, size: img.length });

    const meta = await sharp(calls.upload[0].body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1200);
  });

  it('fotos chicas no se agrandan', async () => {
    const { svc, calls } = build();
    const img = await jpeg(800, 500);
    await svc.upload('u-1', 'selfie', { buffer: img, size: img.length });
    const meta = await sharp(calls.upload[0].body).metadata();
    expect([meta.width, meta.height]).toEqual([800, 500]);
  });

  it('si el bucket ya existe y es privado, no lo vuelve a crear', async () => {
    const { svc, calls } = build(CONFIGURED, { public: false });
    const img = await jpeg(100, 60);
    await svc.upload('u-1', 'idBack', { buffer: img, size: img.length });
    expect(calls.createBucket).toHaveLength(0);
    expect(calls.upload).toHaveLength(1);
  });

  it('si el bucket es PÚBLICO se niega a subir cédulas (503)', async () => {
    const { svc, calls } = build(CONFIGURED, { public: true });
    const img = await jpeg(100, 60);
    await expect(
      svc.upload('u-1', 'idFront', { buffer: img, size: img.length }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(calls.upload).toHaveLength(0);
  });

  it('usa SUPABASE_KYC_BUCKET si está definido', async () => {
    const { svc, calls } = build({ ...CONFIGURED, SUPABASE_KYC_BUCKET: 'docs-privados' });
    const img = await jpeg(100, 60);
    await svc.upload('u-1', 'insurance', { buffer: img, size: img.length });
    expect(calls.createBucket[0][0]).toBe('docs-privados');
  });

  it('signedUrl firma por 10 minutos y devuelve null para valores que no son refs', async () => {
    const { svc, calls } = build();
    const url = await svc.signedUrl('kyc://u-1/idFront/abc.webp');
    expect(url).toBe('https://demo.supabase.co/sign/u-1/idFront/abc.webp?token=x');
    expect(calls.signed).toEqual([['u-1/idFront/abc.webp', 600]]);
    expect(await svc.signedUrl('https://evil.example.com/x.png')).toBeNull();
    expect(await svc.signedUrl(null)).toBeNull();
  });
});
