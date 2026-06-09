'use client';

import { useState, useRef, useEffect, type FormEvent } from 'react';
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep focus in the textbox across turns. Sending a message disables the input
  // while the reply streams, which blurs it; when it re-enables we restore focus
  // so the customer can keep typing without clicking back in. (Only when enabled,
  // so we never steal focus from a dialog or fight a disabled field.)
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSendMessage(trimmed);
    setValue('');
    // Re-assert focus right after submit (covers the case where the input never
    // disables, e.g. a 0-token deterministic reply that returns synchronously).
    inputRef.current?.focus();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 border-t bg-background p-3"
    >
      <Input
        ref={inputRef}
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
