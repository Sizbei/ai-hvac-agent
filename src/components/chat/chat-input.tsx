'use client';

import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { SendHorizontal, Paperclip, X, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PendingAttachment, UploadedAttachment } from '@/lib/types/chat';

interface ChatInputProps {
  readonly onSendMessage: (message: string, attachments?: readonly UploadedAttachment[]) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

const MAX_LENGTH = 2000;
const MAX_ATTACHMENTS = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export function ChatInput({
  onSendMessage,
  disabled = false,
  placeholder = 'Describe your HVAC issue...',
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<readonly PendingAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize the textarea: clamp between 1 and 5 rows.
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
    const maxHeight = lineHeight * 5 + 16; // 5 rows + vertical padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  // Keep focus in the textbox across turns
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  // Re-run resize whenever value changes
  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  // Clean up preview URLs when attachments change
  useEffect(() => {
    return () => {
      attachments.forEach((a) => URL.revokeObjectURL(a.preview));
    };
  }, [attachments]);

  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;

    const newAttachments: PendingAttachment[] = [];

    for (let i = 0; i < files.length && newAttachments.length < MAX_ATTACHMENTS - attachments.length; i++) {
      const file = files[i];

      // Validate file type
      if (!file.type.startsWith('image/')) {
        alert('Only images are allowed');
        continue;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        alert('File size must be less than 5MB');
        continue;
      }

      // Create preview
      const preview = URL.createObjectURL(file);
      const attachment: PendingAttachment = {
        file,
        preview,
        id: `${file.name}-${file.size}-${Date.now()}`,
      };
      newAttachments.push(attachment);
    }

    if (newAttachments.length > 0) {
      setAttachments([...attachments, ...newAttachments]);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.preview);
      }
      return prev.filter((a) => a.id !== id);
    });
  }

  async function handleSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    const trimmed = value.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || disabled || isUploading) return;

    setIsUploading(true);

    try {
      // Upload attachments if present and capture their IDs
      let uploadedAttachments: UploadedAttachment[] = [];
      if (attachments.length > 0) {
        const uploadPromises = attachments.map(async (attachment) => {
          const formData = new FormData();
          formData.append('file', attachment.file);

          const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to upload file');
          }

          const result = await response.json();
          return result.data as UploadedAttachment;
        });

        uploadedAttachments = await Promise.all(uploadPromises);
      }

      onSendMessage(trimmed, uploadedAttachments);

      setValue('');
      setAttachments([]);
      // Reset textarea height after clearing
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      textareaRef.current?.focus();
    } catch (error) {
      console.error('Failed to upload attachments:', error);
      alert('Failed to upload one or more attachments. Please try again.');
    } finally {
      setIsUploading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  return (
    <div className="border-t bg-background">
      {/* Attachment Previews */}
      {attachments.length > 0 && (
        <div className="flex gap-2 p-3 overflow-x-auto">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border"
            >
              <img
                src={attachment.preview}
                alt={attachment.file.name}
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="absolute top-1 right-1 p-1 bg-background/80 rounded-full hover:bg-background"
                aria-label="Remove attachment"
                disabled={isUploading}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-end gap-2 p-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          disabled={disabled || isUploading || attachments.length >= MAX_ATTACHMENTS}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled || isUploading || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach image"
          className="flex-shrink-0 self-end mb-0.5"
        >
          {attachments.length > 0 ? (
            <ImageIcon className="size-4" />
          ) : (
            <Paperclip className="size-4" />
          )}
        </Button>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX_LENGTH))}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isUploading}
          autoFocus
          rows={1}
          aria-label="Chat message input"
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 overflow-y-auto"
          style={{ lineHeight: '1.5rem', minHeight: '2.25rem' }}
        />

        <Button
          type="submit"
          size="icon"
          disabled={(value.trim().length === 0 && attachments.length === 0) || disabled || isUploading}
          aria-label="Send message"
          className="flex-shrink-0 self-end mb-0.5"
        >
          {isUploading ? (
            <span className="size-4 animate-pulse">...</span>
          ) : (
            <SendHorizontal className="size-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
