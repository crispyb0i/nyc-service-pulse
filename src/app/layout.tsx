import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NYC Service Pulse — A month of city life",
  description:
    "Explore August 2026 NYC 311 service requests through a focused, transparent view of daily activity and public records.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
