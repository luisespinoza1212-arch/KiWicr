// Copyright (c) 2026 Francisco Javier Campos Diaz. Todos los derechos reservados.
import {
  Injectable,
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
// Sin esModuleInterop: `import x from` compila a `x.default` (undefined) para
// módulos CommonJS `export =`. Se usa `import = require` a propósito.
import sharp = require('sharp');
import heicConvert = require('heic-convert');

/**
 * Subida REAL de imágenes (productos, evidencias, perfiles, logos).
 *
 * - Supabase Storage vía SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, en el
 *   bucket SUPABASE_STORAGE_BUCKET (default `kiwi`, debe ser PÚBLICO para que
 *   la URL sirva directo en <img>). La service role key vive solo en el
 *   servidor: jamás al browser.
 * - La API normaliza cada imagen ANTES de subirla: cuadrado 512×512 cover en
 *   webp (lo que antes hacía el eager de Cloudinary). El client pinta
 *   thumbnails de 80px y el detalle de 512: una sola versión liviana sirve ambos.
 *   HEIC (alta eficiencia Samsung/iPhone) se convierte primero con
 *   heic-convert, porque el sharp precompilado no decodifica HEVC.
 * - Gracious degradation: sin credenciales el endpoint responde 503 con un
 *   mensaje claro en vez de 500 críptico — la app sigue funcionando con emojis.
 *
 * Validación estricta ANTES de tocar el proveedor (el binario jamás se
 * parsea como JSON — Multer usa memoryStorage y límite en bytes):
 * - Solo image/jpeg|png|webp|gif|heic. Los "magic bytes" se verifican, no se
 *   confía en el filename ni en el content-type que manda el cliente.
 * - Máx 5 MB.
 * - Extensiones: deshabilitadas — un .php renombrado a .jpg es exactamente
 *   lo que esto bloquea. Además, al re-codificar a webp, lo que se guarda es
 *   SIEMPRE una imagen generada por nosotros, nunca el binario original.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const OUTPUT_SIZE = 512;
const DEFAULT_BUCKET = 'kiwi';

const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

const MAGIC_BYTES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  // JPEG: FF D8 FF
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    mime: 'image/png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d,
  },
  // WEBP: "RIFF"...."WEBP"
  {
    mime: 'image/webp',
    test: (b) =>
      b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
  },
  // GIF: "GIF8"
  { mime: 'image/gif', test: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  // HEIC/HEIF: ...."ftyp"+marca (alta eficiencia Samsung/iPhone)
  {
    mime: 'image/heic',
    test: (b) =>
      b.slice(4, 8).toString('ascii') === 'ftyp' &&
      HEIC_BRANDS.has(b.slice(8, 12).toString('ascii')),
  },
];

export type UploadedImageFile = { buffer: Buffer; size: number; originalname?: string };

/** MIME real por magic bytes (null si no es una imagen soportada). */
export function detectImageMime(buffer: Buffer): string | null {
  const sniff = Buffer.from(buffer.subarray(0, 12));
  return MAGIC_BYTES.find((m) => m.test(sniff))?.mime ?? null;
}

/**
 * Validación estricta compartida (productos, perfiles, KYC): vacío → 400,
 * >5 MB → 413, formato no soportado por magic bytes → 400. Devuelve el MIME.
 */
export function assertImageFile(file: UploadedImageFile): string {
  if (!file || !Buffer.isBuffer(file.buffer) || file.size === 0) {
    throw new BadRequestException('Archivo vacío o inválido');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new PayloadTooLargeException('Imagen demasiado grande (máx 5 MB)');
  }
  const mime = detectImageMime(file.buffer);
  if (!mime) {
    throw new BadRequestException('Formato no soportado. Usa JPG, PNG, WEBP, GIF o HEIC.');
  }
  return mime;
}

/** Entrada lista para sharp: HEIC (Samsung/iPhone) se convierte a JPEG antes. */
export async function decodeToSharpInput(buffer: Buffer, mime: string): Promise<Buffer> {
  if (mime !== 'image/heic') return buffer;
  const jpeg = await heicConvert({ buffer, format: 'JPEG', quality: 0.9 });
  return Buffer.from(jpeg as ArrayBuffer);
}

@Injectable()
export class ImageUploadService {
  private readonly logger = new Logger(ImageUploadService.name);
  private readonly client: SupabaseClient | null;
  private readonly bucket: string;

  constructor(private config: ConfigService) {
    const url = (this.config.get<string>('SUPABASE_URL') || '').trim();
    const key = (this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
    this.bucket =
      (this.config.get<string>('SUPABASE_STORAGE_BUCKET') || '').trim() || DEFAULT_BUCKET;
    this.client =
      url.startsWith('https://') && key.length > 0
        ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
        : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /** Valida y sube la foto de producto (carpeta `kiwi/products`). */
  async uploadProductImage(file: {
    buffer: Buffer;
    size: number;
    originalname?: string;
  }): Promise<{ url: string }> {
    return this.uploadToFolder(file, 'kiwi/products');
  }

  /**
   * Valida y sube la foto de evidencia del pedido (carpeta `kiwi/proofs`).
   * Misma validación estricta que `uploadProductImage` (magic bytes, 5MB,
   * 512 webp, errores 400/503); solo cambia la carpeta de destino.
   */
  async uploadProofImage(file: {
    buffer: Buffer;
    size: number;
    originalname?: string;
  }): Promise<{ url: string }> {
    return this.uploadToFolder(file, 'kiwi/proofs');
  }

  /**
   * Valida y sube la foto de perfil del repartidor (carpeta `kiwi/drivers`).
   * Misma validación que el resto; solo cambia la carpeta de destino.
   */
  async uploadDriverPhoto(file: {
    buffer: Buffer;
    size: number;
    originalname?: string;
  }): Promise<{ url: string }> {
    return this.uploadToFolder(file, 'kiwi/drivers');
  }

  /**
   * Valida y sube el avatar del cliente (carpeta `kiwi/customers`).
   * Misma validación que el resto; solo cambia la carpeta de destino.
   */
  async uploadCustomerAvatar(file: {
    buffer: Buffer;
    size: number;
    originalname?: string;
  }): Promise<{ url: string }> {
    return this.uploadToFolder(file, 'kiwi/customers');
  }

  /**
   * Valida y sube el logo del comercio (carpeta `kiwi/merchants`).
   * Misma validación que el resto; solo cambia la carpeta de destino.
   */
  async uploadMerchantLogo(file: {
    buffer: Buffer;
    size: number;
    originalname?: string;
  }): Promise<{ url: string }> {
    return this.uploadToFolder(file, 'kiwi/merchants');
  }

  /** Núcleo compartido: validación estricta + normalización + subida. */
  private async uploadToFolder(
    file: { buffer: Buffer; size: number; originalname?: string },
    folder: string,
  ): Promise<{ url: string }> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Subida de imágenes no configurada. Contacta al administrador.',
      );
    }

    const mime = assertImageFile(file);

    // Normalizar: si los bytes dicen "imagen" pero no se puede decodificar,
    // es un archivo dañado o disfrazado → 400 (culpa del cliente, no nuestra).
    let webp: Buffer;
    try {
      webp = await this.normalize(file.buffer, mime);
    } catch (err: any) {
      this.logger.warn(`Imagen ilegible (${mime}): ${err?.message ?? err}`);
      throw new BadRequestException('No se pudo leer la imagen. Prueba con otra foto.');
    }

    try {
      const url = await this.store(`${folder}/${randomUUID()}.webp`, webp);
      if (!url || !url.startsWith('https://')) {
        throw new Error('Supabase devolvió una URL inesperada');
      }
      return { url };
    } catch (err: any) {
      this.logger.error(`Supabase upload falló: ${err?.message ?? err}`);
      throw new ServiceUnavailableException('No se pudo subir la imagen. Intenta de nuevo.');
    }
  }

  /** Decodifica (HEIC vía heic-convert) y entrega un webp 512×512 cover. */
  async normalize(buffer: Buffer, mime: string): Promise<Buffer> {
    const input = await decodeToSharpInput(buffer, mime);
    return sharp(input, { animated: false })
      .rotate() // respeta la orientación EXIF de fotos de celular
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();
  }

  /** Sube el objeto al bucket y devuelve su URL pública. */
  protected async store(path: string, body: Buffer): Promise<string> {
    const storage = this.client!.storage.from(this.bucket);
    const { error } = await storage.upload(path, body, {
      contentType: 'image/webp',
      cacheControl: '31536000',
      upsert: false,
    });
    if (error) throw error;
    return storage.getPublicUrl(path).data.publicUrl;
  }
}
