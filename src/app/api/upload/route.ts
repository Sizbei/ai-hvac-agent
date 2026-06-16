import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { customerSessions, attachments, messages } from '@/lib/db/schema';
import { withTenant } from '@/lib/db/tenant';
import { getSessionToken } from '@/lib/session';
import { isSameOriginRequest } from '@/lib/session-csrf';
import { slidingWindow, RATE_LIMITS } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  getStorageClient,
  generateStorageKey,
  MAX_FILE_SIZE,
} from '@/lib/storage/r2-client';

export const runtime = 'nodejs';

/**
 * POST /api/upload
 *
 * Handles multipart file uploads from the chat widget.
 * Validates file type, size, and magic bytes before uploading to R2/S3.
 *
 * Request: multipart/form-data with 'file' field
 * Response: JSON with attachment metadata
 */
export async function POST(request: NextRequest) {
  try {
    // CSRF protection: only same-origin requests allowed
    if (!isSameOriginRequest(request)) {
      return NextResponse.json(
        { success: false, error: 'Cross-origin request rejected' },
        { status: 403 },
      );
    }

    // Validate session
    const token = await getSessionToken();
    if (!token) {
      return NextResponse.json(
        { success: false, error: 'No session found' },
        { status: 401 },
      );
    }

    // Rate limit per session — uploads are expensive (storage writes) and were
    // previously unthrottled.
    const rate = slidingWindow(
      `upload:${token}`,
      RATE_LIMITS.sessionAction.maxRequests,
      RATE_LIMITS.sessionAction.windowMs,
    );
    if (!rate.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many uploads, please slow down' },
        { status: 429 },
      );
    }

    const [session] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Session not found' },
        { status: 404 },
      );
    }

    const organizationId = session.organizationId;

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 },
      );
    }

    // Validate file
    const storageClient = getStorageClient();
    const validatedMime = storageClient.validateFile(file, MAX_FILE_SIZE);

    if (!validatedMime) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid file. Only JPEG and PNG images under ${MAX_FILE_SIZE / 1024 / 1024}MB are allowed.`,
        },
        { status: 400 },
      );
    }

    // Generate secure storage key
    const storageKey = generateStorageKey(
      organizationId,
      session.id,
      file.name,
    );

    // Upload to R2/S3
    let uploadResult;
    try {
      uploadResult = await storageClient.uploadFile(file, storageKey, validatedMime);
    } catch (uploadError) {
      logger.error({ error: uploadError, sessionId: session.id }, 'File upload failed');
      return NextResponse.json(
        { success: false, error: 'Failed to upload file' },
        { status: 500 },
      );
    }

    // Create attachment record (message_id will be set when the user sends the message)
    const [attachment] = await db
      .insert(attachments)
      .values({
        organizationId,
        sessionId: session.id,
        messageId: null, // Will be linked when user sends a message with this attachment
        filename: file.name,
        mimeType: validatedMime,
        size: file.size,
        storageKey,
      })
      .returning();

    logger.info(
      {
        attachmentId: attachment.id,
        sessionId: session.id,
        filename: file.name,
        size: file.size,
      },
      'File attachment created',
    );

    return NextResponse.json({
      success: true,
      data: {
        id: attachment.id,
        storageKey: attachment.storageKey,
        url: uploadResult.url,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Upload endpoint error');
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
