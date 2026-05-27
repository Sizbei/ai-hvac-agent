'use client';

import { useState, type FormEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ChatInputProps {
  readonly onSendMessage: (message: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

const MAX_LENGTH = 2000;

export function ChatInput({
  onSendMessage,
  disabled = false,
  placeholder = 'Describe your HVAC issue...',
}: ChatInputProps) {
  const [value, setValue] = useState('');

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSendMessage(trimmed);
    setValue('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 border-t bg-background p-3"
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, MAX_LENGTH))}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus
        className="flex-1"
        aria-label="Chat message input"
      />
      <Button
        type="submit"
        size="icon"
        disabled={value.trim().length === 0 || disabled}
        aria-label="Send message"
      >
        <SendHorizontal className="size-4" />
      </Button>
    </form>
  );
}
