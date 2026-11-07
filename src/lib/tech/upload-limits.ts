/**
 * The technician upload cap (M3d spec §7.7), shared by the phone (resize, PDF
 * pick) and the photo route. Vercel Functions cap request bodies at 4.5 MB;
 * 4 MB leaves room for the multipart envelope. Client-safe: no imports.
 */
export const TECH_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
export const FILE_TOO_LARGE_COPY = "This file is too large. The limit is 4 MB.";
