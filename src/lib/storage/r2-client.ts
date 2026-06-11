/**
 * R2/S3 Storage Client
 *
 * Provides file upload capabilities using Cloudflare R2 (S3-compatible API).
 * Used for customer photo uploads during HVAC chat sessions.
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { logger } from '@/lib/logger';

// Maximum file size: 5MB
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Maximum filename length to prevent path overflow attacks
export const MAX_FILENAME_LENGTH = 255;

// Allowed image MIME types with their magic byte signatures
const ALLOWED_TYPES = [
  {
    mime: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    magic: [[0xFF, 0xD8, 0xFF]], // JPEG magic bytes
  },
  {
    mime: 'image/png',
    extensions: ['.png'],
    magic: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]], // PNG magic bytes
  },
] as const;

type AllowedMimeType = (typeof ALLOWED_TYPES)[number]['mime'];

/**
 * Verifies a file's magic bytes match its declared MIME type.
 * Prevents upload attacks where a malicious file is disguised as an image.
 *
 * @param buffer - File buffer to check
 * @param declaredMimeType - MIME type from the upload request
 * @returns true if the file is valid
 */
export function verifyMagicBytes(
  buffer: ArrayBuffer,
  declaredMimeType: string,
): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 16));

  const allowedType = ALLOWED_TYPES.find((t) => t.mime === declaredMimeType);
  if (!allowedType) {
    logger.warn({ mimeType: declaredMimeType }, 'Unknown MIME type');
    return false;
  }

  // Check if the magic bytes match any of the signatures for this type
  return allowedType.magic.some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
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
   * @returns Validated MIME type or null if invalid
   */
  validateFile(file: File, maxSize: number = MAX_FILE_SIZE): AllowedMimeType | null {
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
