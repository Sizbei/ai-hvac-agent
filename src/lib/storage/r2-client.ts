/**
 * R2/S3 Storage Client
 *
 * Provides file upload capabilities using Cloudflare R2 (S3-compatible API).
 * Used for customer photo uploads during HVAC chat sessions.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '@/lib/logger';

// Maximum file size: 5MB for images. Documents (PDF) get a larger ceiling.
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const MAX_DOCUMENT_FILE_SIZE = 20 * 1024 * 1024;

// Maximum filename length to prevent path overflow attacks
export const MAX_FILENAME_LENGTH = 255;

// Default TTL for signed read URLs (15 minutes). Short-lived so a leaked URL
// expires quickly; long enough for a browser to load the asset.
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * A magic-byte signature: a sequence of expected bytes anchored at `offset`.
 * Anchoring at an offset lets us validate container formats (HEIC, WebP) whose
 * brand marker is not at byte 0.
 */
interface MagicSignature {
  readonly offset: number;
  readonly bytes: readonly number[];
}

// Allowed MIME types with their magic byte signatures. Every type listed here
// MUST have a real content-validation signature — never an allowlist string
// alone — so a disguised file is rejected at upload time.
const ALLOWED_TYPES = [
  {
    mime: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    // JPEG: FF D8 FF at byte 0.
    magic: [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  },
  {
    mime: 'image/png',
    extensions: ['.png'],
    // PNG: 89 50 4E 47 0D 0A 1A 0A at byte 0.
    magic: [
      [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
    ],
  },
  {
    mime: 'image/webp',
    extensions: ['.webp'],
    // WebP (RIFF container): 'RIFF' at 0, then 'WEBP' at 8. Both must match —
    // checking only 'RIFF' would accept WAV/AVI files.
    magic: [
      [
        { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'
        { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // 'WEBP'
      ],
    ],
  },
  {
    mime: 'application/pdf',
    extensions: ['.pdf'],
    // PDF: '%PDF' (25 50 44 46) at byte 0.
    magic: [[{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }]],
  },
  {
    mime: 'image/heic',
    extensions: ['.heic', '.heif'],
    // HEIC/HEIF (ISO-BMFF): 'ftyp' box type at bytes 4-7, then a HEIF-family
    // major brand at bytes 8-11. We accept any of the common still-image brands.
    // Each entry below is a full signature (ftyp + one brand) that must all match.
    magic: [
      [
        { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // 'ftyp'
        { offset: 8, bytes: [0x68, 0x65, 0x69, 0x63] }, // 'heic'
      ],
      [
        { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // 'ftyp'
        { offset: 8, bytes: [0x68, 0x65, 0x69, 0x78] }, // 'heix'
      ],
      [
        { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // 'ftyp'
        { offset: 8, bytes: [0x68, 0x65, 0x69, 0x66] }, // 'heif'
      ],
      [
        { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // 'ftyp'
        { offset: 8, bytes: [0x6d, 0x69, 0x66, 0x31] }, // 'mif1'
      ],
    ],
  },
] as const satisfies readonly {
  mime: string;
  extensions: readonly string[];
  magic: readonly (readonly MagicSignature[])[];
}[];

export type AllowedMimeType = (typeof ALLOWED_TYPES)[number]['mime'];

// validateFile takes an explicit allowlist so broadening one upload path never
// silently broadens another. The public chat upload keeps its original
// jpeg/png-only contract (the default). Admin document uploads opt into the
// wider set (images incl. webp/heic + PDF).
export const PUBLIC_UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
] as const satisfies readonly AllowedMimeType[];

export const ADMIN_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const satisfies readonly AllowedMimeType[];

/**
 * Verifies a file's magic bytes match its declared MIME type.
 * Prevents upload attacks where a malicious file is disguised as an allowed type.
 *
 * A type may declare several alternative signatures (e.g. HEIC brands); the file
 * is valid if it matches ALL byte-runs of ANY one alternative.
 *
 * @param buffer - File buffer to check
 * @param declaredMimeType - MIME type from the upload request
 * @returns true if the file is valid
 */
export function verifyMagicBytes(
  buffer: ArrayBuffer,
  declaredMimeType: string,
): boolean {
  // Read enough leading bytes to cover the furthest offset we check (HEIC/WebP
  // brand at byte 8-11).
  const bytes = new Uint8Array(buffer.slice(0, 16));

  const allowedType = ALLOWED_TYPES.find((t) => t.mime === declaredMimeType);
  if (!allowedType) {
    logger.warn({ mimeType: declaredMimeType }, 'Unknown MIME type');
    return false;
  }

  // Match if any alternative signature fully matches.
  return allowedType.magic.some((signature) =>
    signature.every((run) =>
      run.bytes.every((byte, i) => bytes[run.offset + i] === byte),
    ),
  );
}

/**
 * Normalizes a MIME type string, handling common variations.
 */
function normalizeMimeType(mimeType: string): AllowedMimeType | null {
  const normalized = mimeType.toLowerCase().trim();
  if (normalized.startsWith('image/jpeg') || normalized.startsWith('image/jpg')) {
    return 'image/jpeg';
  }
  if (normalized.startsWith('image/png')) {
    return 'image/png';
  }
  if (normalized.startsWith('image/webp')) {
    return 'image/webp';
  }
  if (normalized.startsWith('image/heic') || normalized.startsWith('image/heif')) {
    return 'image/heic';
  }
  if (normalized.startsWith('application/pdf')) {
    return 'application/pdf';
  }
  return null;
}

/**
 * Sanitizes a filename for safe storage.
 * - Truncates to MAX_FILENAME_LENGTH
 * - Removes non-alphanumeric characters except dots, underscores, hyphens
 *
 * @param filename - Original filename
 * @returns Sanitized filename safe for storage
 */
export function sanitizeFilename(filename: string): string {
  // Truncate to max length
  const truncated = filename.slice(0, MAX_FILENAME_LENGTH);
  // Remove potentially dangerous characters, keep safe ones
  return truncated.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Generates a secure, tenant-scoped storage key for uploaded files.
 * Format: org_${orgId}_session_${sessionId}_${nanoid(12)}.${ext}
 *
 * @param organizationId - Organization ID for multi-tenant isolation
 * @param sessionId - Session ID the file belongs to
 * @param filename - Original filename to extract extension
 * @returns Secure storage key
 */
export function generateStorageKey(
  organizationId: string,
  sessionId: string,
  filename: string,
): string {
  const sanitized = sanitizeFilename(filename);
  const ext = sanitized.includes('.')
    ? sanitized.slice(sanitized.lastIndexOf('.'))
    : '';

  // Use crypto.randomUUID() for the random part - available in Node 20+
  const randomId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  return `org_${organizationId}_session_${sessionId}_${randomId}${ext}`;
}

/**
 * Generates a secure, tenant-scoped storage key for an admin-uploaded file that
 * is linked directly to an entity (no chat session).
 * Format: org_${orgId}_admin_${nanoid(12)}.${ext}
 *
 * @param organizationId - Organization ID for multi-tenant isolation
 * @param filename - Original filename to extract extension
 * @returns Secure storage key
 */
export function generateAdminStorageKey(
  organizationId: string,
  filename: string,
): string {
  const sanitized = sanitizeFilename(filename);
  const ext = sanitized.includes('.')
    ? sanitized.slice(sanitized.lastIndexOf('.'))
    : '';

  const randomId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  return `org_${organizationId}_admin_${randomId}${ext}`;
}

/**
 * Storage client interface
 */
export interface StorageUploadResult {
  readonly storageKey: string;
  readonly url: string;
}

export class StorageClient {
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly publicUrl: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;
    const endpoint = process.env.R2_ENDPOINT;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
      throw new Error(
        'Missing required R2 configuration: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL',
      );
    }

    // Use R2 endpoint if provided, otherwise construct from account ID
    const r2Endpoint =
      endpoint || `https://${accountId || ''}.r2.cloudflarestorage.com`;

    this.client = new S3Client({
      region: 'auto',
      endpoint: r2Endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.bucketName = bucketName;
    this.publicUrl = publicUrl.replace(/\/$/, '');
  }

  /**
   * Validates an uploaded file before storage.
   *
   * @param file - File to validate
   * @param maxSize - Maximum allowed file size in bytes
   * @param allowedMimeTypes - Allowlist of accepted normalized MIME types.
   *   Defaults to the public chat upload's jpeg/png-only contract.
   * @returns Validated MIME type or null if invalid
   */
  validateFile(
    file: File,
    maxSize: number = MAX_FILE_SIZE,
    allowedMimeTypes: readonly AllowedMimeType[] = PUBLIC_UPLOAD_MIME_TYPES,
  ): AllowedMimeType | null {
    // Check file size
    if (file.size > maxSize) {
      logger.warn(
        { size: file.size, maxSize, name: file.name },
        'File size exceeded',
      );
      return null;
    }

    // Normalize and validate MIME type
    const normalizedMime = normalizeMimeType(file.type);
    if (!normalizedMime) {
      logger.warn({ mimeType: file.type, name: file.name }, 'Invalid MIME type');
      return null;
    }

    // Enforce the caller's allowlist (a normalized type can still be outside the
    // set this upload path permits).
    if (!allowedMimeTypes.includes(normalizedMime)) {
      logger.warn(
        { mimeType: normalizedMime, name: file.name },
        'MIME type not permitted for this upload',
      );
      return null;
    }

    return normalizedMime;
  }

  /**
   * Uploads a file to R2/S3 storage.
   *
   * @param file - File to upload
   * @param storageKey - Storage key for the file
   * @param mimeType - Validated MIME type
   * @returns Upload result with storage key and public URL
   */
  async uploadFile(
    file: File,
    storageKey: string,
    mimeType: AllowedMimeType,
  ): Promise<StorageUploadResult> {
    const buffer = await file.arrayBuffer();

    // Verify magic bytes match the declared type
    if (!verifyMagicBytes(buffer, mimeType)) {
      throw new Error('File content does not match declared MIME type');
    }

    const input: PutObjectCommandInput = {
      Bucket: this.bucketName,
      Key: storageKey,
      Body: new Uint8Array(buffer),
      ContentType: mimeType,
      // Make files publicly readable so they can be displayed in chat
      ACL: undefined, // R2 uses public buckets, no ACL needed
    };

    try {
      await this.client.send(new PutObjectCommand(input));
      logger.info({ storageKey, size: file.size }, 'File uploaded to R2');

      return {
        storageKey,
        url: `${this.publicUrl}/${storageKey}`,
      };
    } catch (error) {
      logger.error({ error, storageKey }, 'Failed to upload file to R2');
      throw new Error('Failed to upload file');
    }
  }

  /**
   * Deletes a file from R2/S3 storage.
   *
   * @param storageKey - Storage key of the file to delete
   */
  async deleteFile(storageKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: storageKey,
        }),
      );
      logger.info({ storageKey }, 'File deleted from R2');
    } catch (error) {
      logger.error({ error, storageKey }, 'Failed to delete file from R2');
      throw new Error('Failed to delete file');
    }
  }

  /**
   * Generates a short-lived, signed read URL for a stored object.
   *
   * Used to serve access-controlled attachments without exposing the bucket
   * publicly or leaking the raw object key/credentials. The caller MUST verify
   * the requester owns the object (tenant scope) BEFORE calling this.
   *
   * @param storageKey - Storage key of the object to read
   * @param ttlSeconds - URL lifetime in seconds (default 15 minutes)
   * @returns A presigned HTTPS URL valid for `ttlSeconds`
   */
  async getSignedReadUrl(
    storageKey: string,
    ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: storageKey,
        }),
        { expiresIn: ttlSeconds },
      );
    } catch (error) {
      logger.error(
        { error, storageKey },
        'Failed to sign read URL for R2 object',
      );
      throw new Error('Failed to sign read URL');
    }
  }
}

// Singleton instance
let storageClientInstance: StorageClient | null = null;

/**
 * Gets or creates the storage client singleton.
 */
export function getStorageClient(): StorageClient {
  if (!storageClientInstance) {
    storageClientInstance = new StorageClient();
  }
  return storageClientInstance;
}
