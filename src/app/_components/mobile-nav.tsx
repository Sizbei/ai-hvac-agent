"use client";

import Link from "next/link";
import { Menu, Phone, Wind } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const NAV = [
  { label: "Request service", href: "/chat" },
  { label: "Staff sign in", href: "/admin" },
];

/**
 * Phone menu. A homeowner opening it needs the two real actions first — get
 * service (the chat) and call — before the staff sign-in link.
 */
export function MobileNav({
  phoneDisplay,
  phoneTel,
}: {
  readonly phoneDisplay: string;
  readonly phoneTel: string;
}) {
  return (
    <Sheet>
      <SheetTrigger
        className="flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[var(--dur-hover)] hover:bg-accent hover:text-foreground md:hidden"
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="right" className="w-64 px-0 pt-0">
        <SheetHeader className="border-b border-border-strong px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Wind className="size-4" strokeWidth={2.25} />
            </span>
            <span className="font-heading font-semibold tracking-tight">Spears Services</span>
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-2 border-b border-border px-4 py-4">
          <Link
            href="/chat"
            className="flex min-h-11 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors duration-[var(--dur-hover)] hover:bg-primary-deep"
          >
            Get service
          </Link>
          <a
            href={`tel:${phoneTel}`}
            className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-input px-3 text-sm font-medium text-foreground transition-colors duration-[var(--dur-hover)] hover:bg-accent"
          >
            <Phone className="size-4" aria-hidden="true" />
            Call {phoneDisplay}
          </a>
        </div>
        <nav className="flex flex-col gap-1 p-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-[var(--dur-hover)] hover:bg-accent hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
