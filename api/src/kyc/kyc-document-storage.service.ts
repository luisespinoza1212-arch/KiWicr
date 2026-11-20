import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import sharp = require('sharp');
import {
  assertImageFile,
  decodeToSharpInput,
  UploadedImageFile,
} from '../menu/image-upload.service';

/**
 * Documentos KYC (cédula, selfie, licencia...) en un bucket PRIVADO de
 * Supabase Storage.
 *
 * Son datos personales sensibles (Ley 8968), así que:
 * - Nunca hay URL pública: se guarda una referencia opaca `kyc://<path>` y
 *   solo el admin obtiene links firmados que vencen (`signedUrl`).
 * - El path empieza por el userId del dueño: `submitDocuments` solo acepta
 *   referencias del propio usuario (nadie adjunta documentos ajenos).
 * - Si el bucket no existe se crea privado; si existe y es PÚBLICO se niega a
 *   subir (503) en vez de exponer cédulas.
 * - La imagen se re-codifica a webp SIN recortar (fit inside, máx 2000 px)
 *   para que el documento se lea completo.
 */

export const KYC_DOC_TYPES = [
  'idFront',
  'idBack',
  'selfie',
  'license',
  'vehicleRegister',
  'insurance',
] as const;
export type KycDocType = (typeof KYC_DOC_TYPES)[number];

export const KYC_REF_PREFIX = 'kyc://';
const DEFAULT_KYC_BUCKET = 'kyc-private';
const MAX_DIM = 2000;
const SIGNED_URL_TTL_S = 600; // 10 min

export function isKycDocType(value: unknown): value is KycDocType {
  return typeof value === 'string' && (KYC_DOC_TYPES as readonly string[]).includes(value);
}

/** ¿Es una referencia KYC válida y del propio usuario? */
export function isOwnKycRef(value: unknown, userId: string): value is string {
  if (typeof value !== 'string' || value.length > 512 || !userId) return false;
  if (!value.startsWith(KYC_REF_PREFIX)) return false;
  const path = value.slice(KYC_REF_PREFIX.length);
  // <userId>/<docType>/<uuid>.webp — sin "..", sin barras dobles.
  const parts = path.split('/');
  return (
    parts.length === 3 &&
    parts[0] === userId &&
    isKycDocType(parts[1]) &&
    /^[0-9a-f-]{36}\.webp$/.test(parts[2])
  );
}

@Injectable()
export class KycDocumentStorage {
  private readonly logger = new Logger(KycDocumentStorage.name);
  private readonly client: SupabaseClient | null;
  private readonly bucket: string;
  private bucketReady: Promise<void> | null = null;

  constructor(private config: ConfigService) {
    const url = (this.config.get<string>('SUPABASE_URL') || '').trim();
    const key = (this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
    this.bucket =
      (this.config.get<string>('SUPABASE_KYC_BUCKET') || '').trim() || DEFAULT_KYC_BUCKET;
    this.client =
      url.startsWith('https://') && key.length > 0
        ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
        : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /** Valida, normaliza y guarda el documento. Devuelve la referencia opaca. */
  async upload(userId: string, type: unknown, file: UploadedImageFile): Promise<{ ref: string }> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Subida de documentos no configurada. Contacta al administrador.',
      );
    }
    if (!isKycDocType(type)) {
      throw new BadRequestException('Tipo de documento inválido');
    }
    const mime = assertImageFile(file);

    let webp: Buffer;
    try {
      webp = await this.normalize(file.buffer, mime);
    } catch (err: any) {
      this.logger.warn(`Documento ilegible (${mime}): ${err?.message ?? err}`);
      throw new BadRequestException('No se pudo leer la foto. Prueba con otra.');
    }

    const path = `${userId}/${type}/${randomUUID()}.webp`;
    try {
      await this.ensurePrivateBucket();
      await this.store(path, webp);
    } catch (err: any) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Subida KYC falló: ${err?.message ?? err}`);
      throw new ServiceUnavailableException('No se pudo subir el documento. Intenta de nuevo.');
    }
    return { ref: `${KYC_REF_PREFIX}${path}` };
  }

  /** Link firmado temporal para una referencia `kyc://` (null si no aplica). */
  async signedUrl(ref: unknown, ttlSeconds = SIGNED_URL_TTL_S): Promise<string | null> {
    if (!this.isConfigured() || typeof ref !== 'string' || !ref.startsWith(KYC_REF_PREFIX)) {
      return null;
    }
    const path = ref.slice(KYC_REF_PREFIX.length);
    try {
      return await this.sign(path, ttlSeconds);
    } catch (err: any) {
      this.logger.warn(`No se pudo firmar documento KYC: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Webp sin recortar: rota por EXIF y limita el lado mayor a 2000 px. */
  async normalize(buffer: Buffer, mime: string): Promise<Buffer> {
    const input = await decodeToSharpInput(buffer, mime);
    return sharp(input, { animated: false })
      .rotate()
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  }

  /** Crea el bucket privado si falta; si existe y es público, se niega. */
  protected ensurePrivateBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        const storage = this.client!.storage;
        const { data, error } = await storage.getBucket(this.bucket);
        if (data) {
          if (data.public) {
            this.logger.error(
              `El bucket "${this.bucket}" es PÚBLICO: se rechazan documentos KYC hasta que sea privado.`,
            );
            throw new ServiceUnavailableException(
              'Almacenamiento de documentos mal configurado. Contacta al administrador.',
            );
          }
          return;
        }
        if (error && !/not.?found/i.test(error.message)) throw error;
        const created = await storage.createBucket(this.bucket, { public: false });
        if (created.error && !/already exists/i.test(created.error.message)) throw created.error;
      })().catch((err) => {
        this.bucketReady = null; // reintentar en la próxima subida
        throw err;
      });
    }
    return this.bucketReady;
  }

  protected async store(path: string, body: Buffer): Promise<void> {
    const { error } = await this.client!.storage.from(this.bucket).upload(path, body, {
      contentType: 'image/webp',
      upsert: false,
    });
    if (error) throw error;
  }

  protected async sign(path: string, ttlSeconds: number): Promise<string | null> {
    const { data, error } = await this.client!.storage.from(this.bucket).createSignedUrl(
      path,
      ttlSeconds,
    );
    if (error) throw error;
    return data?.signedUrl ?? null;
  }
}
