'use client';

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { SendHorizontal, Paperclip, X, Image as ImageIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { PendingAttachment } from '@/lib/types/chat';

interface ChatInputProps {
  readonly onSendMessage: (message: string, attachments?: readonly PendingAttachment[]) => void;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep focus in the textbox across turns
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

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
    const uploadPromises: Promise<void>[] = [];

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

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || disabled || isUploading) return;

    setIsUploading(true);

    try {
      // Upload attachments if present
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

          return await response.json();
        });

        await Promise.all(uploadPromises);
      }

      onSendMessage(trimmed, attachments);

      setValue('');
      setAttachments([]);
      inputRef.current?.focus();
    } catch (error) {
      console.error('Failed to upload attachments:', error);
      alert('Failed to upload one or more attachments. Please try again.');
    } finally {
      setIsUploading(false);
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

      <form onSubmit={handleSubmit} className="flex items-center gap-2 p-3">
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
        >
          {attachments.length > 0 ? (
            <ImageIcon className="size-4" />
          ) : (
            <Paperclip className="size-4" />
          )}
        </Button>

        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX_LENGTH))}
          placeholder={placeholder}
          disabled={disabled || isUploading}
          autoFocus
          className="flex-1"
          aria-label="Chat message input"
        />
        <Button
          type="submit"
          size="icon"
          disabled={(value.trim().length === 0 && attachments.length === 0) || disabled || isUploading}
          aria-label="Send message"
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
