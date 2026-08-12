"use client";

import Link from "next/link";
import { Menu, Wind } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const NAV = [
  { label: "Live demo", href: "/chat" },
  { label: "Admin", href: "/admin" },
  { label: "Docs", href: "/docs.html" },
];

export function MobileNav() {
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
