import type { Metadata } from "next";
import "./globals.css";
import { ModeBanner } from "@/components/ModeBanner";

export const metadata: Metadata = {
  title: "ResolvePay",
  description: "AI returns-and-refunds copilot for small merchants. Sandbox demo.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <ModeBanner />
        {children}
      </body>
    </html>
  );
}
